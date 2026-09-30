import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock, releaseLock } from '../src/lock.js';
import { cacheDirFor } from '../src/paths.js';
import { pacingDelay, parseUsage, readUsage, recordUsage, reserveUsage, spentIn, usageLedgerFor } from '../src/usage-ledger.js';
import { tempDir } from './repo-helpers.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const [A, B, C] = ['a', 'b', 'c'].map((letter) => letter.repeat(16)) as [string, string, string];
const line = (repo: string, ts: number, points: number) => ({ ts, host: 'github.com', repo, points });
const jsonl = (lines: readonly unknown[]) => lines.map((entry) => `${JSON.stringify(entry)}\n`).join('');
const REGISTRY = join('/', 'repo', 'a', '.git', 'epic-pulse');

test('the ledger lives in the OS cache directory, unless EPIC_PULSE_CACHE_DIR names another', (t) => {
  const override = tempDir(t);
  const cases: readonly (readonly [NodeJS.ProcessEnv, NodeJS.Platform, string | undefined, string | undefined])[] = [
    [{}, 'darwin', '/Users/u', '/Users/u/Library/Caches/epic-pulse'],
    [{ XDG_CACHE_HOME: '/xdg' }, 'darwin', '/Users/u', '/Users/u/Library/Caches/epic-pulse'],
    [{}, 'linux', '/home/u', '/home/u/.cache/epic-pulse'],
    [{ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u', '/xdg/epic-pulse'],
    [{ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/u', '/home/u/.cache/epic-pulse'],
    [{ LOCALAPPDATA: 'D:\\Local' }, 'win32', 'C:\\Users\\u', 'D:\\Local\\epic-pulse'],
    [{}, 'win32', 'C:\\Users\\u', 'C:\\Users\\u\\AppData\\Local\\epic-pulse'],
    [{ EPIC_PULSE_CACHE_DIR: override }, 'linux', undefined, override],
    [{}, 'linux', undefined, undefined],
  ];
  for (const [env, platform, home, expected] of cases) {
    assert.equal(cacheDirFor(env, platform, home), expected, `${platform} ${JSON.stringify(env)}`);
  }
});

test('a registry is known to the ledger by a hash of its directory, never by the path', () => {
  const ledger = usageLedgerFor(join('/', 'cache'), REGISTRY);
  assert.match(ledger.repo, /^[0-9a-f]{16}$/);
  assert.equal(usageLedgerFor(join('/', 'cache'), join(REGISTRY, '..', 'epic-pulse')).repo, ledger.repo);
  assert.notEqual(usageLedgerFor(join('/', 'cache'), join('/', 'repo', 'b', '.git', 'epic-pulse')).repo, ledger.repo);
  assert.equal(ledger.file, join('/', 'cache', 'usage.jsonl'));
});

test('torn, foreign and malformed ledger lines are skipped while the valid ones still count', async (t) => {
  const file = join(tempDir(t), 'usage.jsonl');
  assert.deepEqual(await readUsage(file), []);
  const foreign = `{"ts":1,"host":"x y","repo":"${A}","points":1}\n`;
  writeFileSync(file, `${jsonl([line(A, T0, 3)])}not json\n${foreign}${jsonl([line(B, T0, 0), line(B, T0 + 1, 2)])}{"ts":17`);
  assert.deepEqual(await readUsage(file), [line(A, T0, 3), line(B, T0 + 1, 2)]);
});

test('a reservation fits only while the last hour of every repository plus its own cost stays within 300', async (t) => {
  const ledger = usageLedgerFor(tempDir(t), REGISTRY);
  writeFileSync(ledger.file, jsonl([line(B, T0 - 10 * MIN, 290), line(C, T0 - 61 * MIN, 50)]));
  const request = (points: number) => ({ ts: T0, host: 'github.com', points });
  assert.deepEqual(await reserveUsage(ledger, request(11), T0), { granted: false, spent: 290, detail: null });
  assert.deepEqual(await reserveUsage(ledger, request(10), T0), { granted: true, spent: 300, detail: null });
  assert.deepEqual(await reserveUsage(ledger, request(1), T0), { granted: false, spent: 300, detail: null });
  assert.deepEqual(parseUsage(readFileSync(ledger.file, 'utf8')), [line(B, T0 - 10 * MIN, 290), line(ledger.repo, T0, 10)]);
});

test('every write drops the lines outside the hour and a torn tail, and keeps the rest in order', async (t) => {
  const ledger = usageLedgerFor(tempDir(t), REGISTRY);
  const kept = [line(B, T0 - 59 * MIN, 5), line(C, T0 + 30 * MIN, 1)];
  writeFileSync(ledger.file, `${jsonl([line(B, T0 - 61 * MIN, 5), ...kept, line(C, T0 + 61 * MIN, 7)])}{"ts":1`);
  assert.equal(await recordUsage(ledger, { ts: T0, host: 'github.com', points: 2 }, T0), true);
  const text = readFileSync(ledger.file, 'utf8');
  assert.deepEqual(parseUsage(text), [...kept, line(ledger.repo, T0, 2)]);
  assert.equal(text.split('\n').filter(Boolean).length, 3);
  if (process.platform !== 'win32') assert.equal(statSync(ledger.file).mode & 0o777, 0o600);
});

test('a ledger locked by another refresher refuses the reservation instead of guessing', async (t) => {
  const ledger = usageLedgerFor(tempDir(t), REGISTRY);
  const now = Date.now();
  const held = await acquireLock(ledger.lockFile, { now, staleMs: 60_000 });
  assert.ok(held);
  const request = { ts: now, host: 'github.com', points: 1 };
  assert.deepEqual(await reserveUsage(ledger, request, now), { granted: false, spent: undefined, detail: 'ledger' });
  assert.deepEqual(await readUsage(ledger.file), []);
  await releaseLock(held);
  assert.deepEqual(await reserveUsage(ledger, request, now), { granted: true, spent: 1, detail: null });
});

// Permissions do not apply to root, and Windows has no mode bits to take away.
const canRevokeRead = process.platform !== 'win32' && process.getuid?.() !== 0;

test('a ledger that exists but can not be read refuses the charge instead of being replaced', { skip: !canRevokeRead }, async (t) => {
  const ledger = usageLedgerFor(tempDir(t), REGISTRY);
  writeFileSync(ledger.file, jsonl([line(B, T0, 5)]));
  chmodSync(ledger.file, 0o000);
  assert.deepEqual(await reserveUsage(ledger, { ts: T0, host: 'github.com', points: 1 }, T0), { granted: false, spent: undefined, detail: 'ledger' });
  chmodSync(ledger.file, 0o600);
  assert.deepEqual(await readUsage(ledger.file), [line(B, T0, 5)]);
});

test('pacing: a repository waits for its last cost at its share of 300 points an hour', () => {
  const lines = [line(A, T0 - 20 * MIN, 30), line(A, T0, 1), line(A, T0, 3), line(B, T0 - 5 * MIN, 6), line(C, T0 - 61 * MIN, 9)];
  // A's last refresh cost 1 + 3 points; A and B share the hour (C is older): 4 x 12 s x 2.
  assert.equal(pacingDelay(lines, A, T0), 96_000);
  assert.equal(pacingDelay(lines, A, T0 + 10_000), 86_000);
  assert.equal(pacingDelay(lines, A, T0 + 96_000), 0);
  assert.equal(pacingDelay(lines.filter((entry) => entry.repo !== B), A, T0), 48_000);
  assert.equal(pacingDelay(lines, C, T0), 0);
  assert.equal(pacingDelay([], A, T0), 0);
  assert.equal(spentIn(lines, T0), 30 + 1 + 3 + 6);
});
