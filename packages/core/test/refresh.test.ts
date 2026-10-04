import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireLock, releaseLock } from '../src/lock.js';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { addPin } from '../src/pins.js';
import { makeRef, refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { RESOLUTION_TTL_MS } from '../src/refresh-plan.js';
import { appendRegistryLine } from '../src/registry.js';
import type { IssueRef } from '../src/schemas/common.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot, filesUnder, noGhEnv } from './snapshot-helpers.js';

const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const SENTINEL = 'SENTINEL-7f3a-never-persist';
const invalid = (number: number) => makeRef({ host: 'epic-pulse.invalid', owner: 'acme', repo: 'widgets', number })!;
// A line another repository's refresher left in the user's usage ledger.
const otherRepo = (ts: number, points: number) => `${JSON.stringify({ ts, host: 'github.com', repo: 'f'.repeat(16), points })}\n`;

// With a token for the `.invalid` host, which EPIC_PULSE_HOSTS names, every
// admitted request really goes out and really fails, offline (see the token
// test at the end).
function sendingEnv(t: TestContext, cache: string): NodeJS.ProcessEnv {
  return noGhEnv(t, { GH_ENTERPRISE_TOKEN: 'x', EPIC_PULSE_HOSTS: 'epic-pulse.invalid', EPIC_PULSE_CACHE_DIR: cache });
}

async function boundRegistry(t: TestContext, refs: readonly IssueRef[]): Promise<RegistryPaths> {
  const paths = pathsFor(tempDir(t));
  const binds = refs.map((ref) => ({ ref, via: 'gh' as const }));
  assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: Date.now(), ev: 'tool', binds })).ok);
  return paths;
}

async function snapshotError(paths: RegistryPaths): Promise<unknown> {
  const read = await readSnapshot(paths.snapshotFile);
  return read.status === 'ok' ? read.snapshot.error : read.status;
}

test('a second refresher finds the lock held and leaves without touching anything', async (t) => {
  const paths = await boundRegistry(t, [demo(4)]);
  const held = await acquireLock(paths.lockFile, { now: Date.now(), staleMs: 60_000 });
  assert.ok(held);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: {} }), { status: 'busy' });
  assert.equal(existsSync(paths.snapshotFile), false);
  await releaseLock(held);
});

test('with nothing bound or pinned a refresh makes no request, writes nothing and releases the lock', async (t) => {
  const paths = pathsFor(tempDir(t));
  const cache = tempDir(t);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: { EPIC_PULSE_CACHE_DIR: cache } }), { status: 'done', requests: 0, points: 0, error: null });
  assert.equal(existsSync(paths.snapshotFile), false);
  assert.equal(existsSync(paths.lockFile), false);
  assert.deepEqual(readdirSync(cache), []);
});

test('a spent hourly budget makes no request and is recorded as budget', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), usage: { windowStart: now - 60_000, points: 300 } });
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'budget' });
  assert.equal(await snapshotError(paths), 'budget');
});

test('an hour later the budget is available again', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), usage: { windowStart: now - 2 * 3_600_000, points: 300 } });
  // Past the budget check, the next gate is the token, which this env lacks.
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'no_token' });
});

test('a low rate limit backs off until its reset, then lets requests through', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), rateLimit: { remaining: 999, resetAt: now + 60_000 } });
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'budget' });
  assert.equal(await snapshotError(paths), 'budget');
  const later = await refresh({ dir: paths.dir, now: now + 61_000, env: noGhEnv(t) });
  assert.deepEqual(later, { status: 'done', requests: 0, points: 0, error: 'no_token' });
});

test('the hourly cap is shared by every repository of the user through the usage ledger', async (t) => {
  // Without a token the user's spent hour still reads as budget, like this repository's own.
  const cases = [[300, true, { requests: 0, error: 'budget' }], [299, true, { requests: 1, error: 'network' }],
    [300, false, { requests: 0, error: 'budget' }]] as const;
  for (const [spent, token, expected] of cases) {
    const now = Date.now();
    const cache = tempDir(t);
    writeFileSync(join(cache, 'usage.jsonl'), otherRepo(now - 60_000, spent));
    const paths = await boundRegistry(t, [invalid(4)]);
    const env = token ? sendingEnv(t, cache) : noGhEnv(t, { EPIC_PULSE_CACHE_DIR: cache });
    const outcome = await refresh({ dir: paths.dir, now, env });
    assert.deepEqual(outcome, { status: 'done', points: 0, ...expected }, `another repository spent ${spent}, token ${token}`);
  }
});

test('each request is charged to the user ledger before it is sent, under a hash rather than a path', async (t) => {
  const now = Date.now();
  const cache = tempDir(t);
  const paths = await boundRegistry(t, [invalid(4)]);
  await refresh({ dir: paths.dir, now, env: sendingEnv(t, cache) });
  const text = readFileSync(join(cache, 'usage.jsonl'), 'utf8');
  const lines = text.split('\n').filter(Boolean).map((raw) => JSON.parse(raw) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ repo, ...rest }) => [typeof repo, rest]), [['string', { ts: now, host: 'epic-pulse.invalid', points: 1 }]]);
  assert.match(String(lines[0]?.['repo']), /^[0-9a-f]{16}$/);
  assert.equal(text.includes(paths.dir), false);
});

// Pacing holds back refreshing cached data: #4 has a resolution, due again.
test('a repository refreshes cached data again only once its last cost is paid off at its share of the hour', async (t) => {
  const now = Date.now();
  const cache = tempDir(t);
  writeFileSync(join(cache, 'usage.jsonl'), otherRepo(now - 60_000, 3)); // so two repositories share the hour
  const paths = await boundRegistry(t, [invalid(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), issues: { [refKey(invalid(4))]: { epic: null, resolvedAt: now - RESOLUTION_TTL_MS } } });
  const env = sendingEnv(t, cache);
  const at = (ms: number) => refresh({ dir: paths.dir, now: now + ms, env });
  const sent = { status: 'done', requests: 1, points: 0, error: 'network' };
  assert.deepEqual(await at(0), sent);
  const before = readFileSync(paths.snapshotFile);
  // The request was charged 1 point: at 300 an hour that is 12 s, times the 2 repositories.
  assert.deepEqual(await at(23_999), { status: 'paced', until: now + 24_000 });
  assert.deepEqual(readFileSync(paths.snapshotFile), before, 'a paced run leaves the snapshot alone');
  assert.deepEqual(await at(24_000), sent);
});

test('a fresh snapshot makes no request and is not rewritten', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  assert.ok((await addPin(paths, demo(8), now)).ok);
  await writeSnapshot(paths.snapshotFile, demoSnapshot(now - 1000));
  const before = readFileSync(paths.snapshotFile);
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: null });
  assert.deepEqual(readFileSync(paths.snapshotFile), before);
});

// No server is involved: `.invalid` never resolves (RFC 6761), so the token is
// really sent through fetch and really fails, and undici builds its errors
// from what it was given. A NUL makes the header itself invalid, which is the
// path where undici echoes the header value, token included, in its message.
test('a token never reaches any file the refresher writes, whatever the failure', async (t) => {
  const cases = [[SENTINEL, 'network'], [`${SENTINEL}\u0000x`, 'invalid_token']] as const;
  for (const [token, code] of cases) {
    const paths = await boundRegistry(t, [invalid(4)]);
    const cache = tempDir(t);
    const env = noGhEnv(t, { GH_ENTERPRISE_TOKEN: token, EPIC_PULSE_HOSTS: 'epic-pulse.invalid', EPIC_PULSE_CACHE_DIR: cache });
    const outcome = await refresh({ dir: paths.dir, now: Date.now(), env });
    assert.deepEqual(outcome, { status: 'done', requests: 1, points: 0, error: code });
    const files = [...filesUnder(paths.dir), ...filesUnder(cache)];
    assert.ok(files.some((file) => file === paths.snapshotFile), 'the failure was written to disk');
    assert.ok(files.some((file) => file === join(cache, 'usage.jsonl')), 'the charge was written to the ledger');
    for (const file of files) assert.equal(readFileSync(file, 'utf8').includes('SENTINEL'), false, file);
  }
});

// Every request is charged to the ledger, under its host, before it is sent:
// these are the hosts a refresh sent something to.
function chargedHosts(cache: string): readonly string[] {
  const file = join(cache, 'usage.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((raw) => String((JSON.parse(raw) as Record<string, unknown>)['host']));
}

test('a token the caller hands over is used for its own host and for no other', async (t) => {
  const cache = tempDir(t);
  const elsewhere = makeRef({ host: 'elsewhere.invalid', owner: 'acme', repo: 'widgets', number: 5 })!;
  const paths = await boundRegistry(t, [invalid(4), elsewhere]);
  const env = noGhEnv(t, { EPIC_PULSE_CACHE_DIR: cache });
  const outcome = await refresh({ dir: paths.dir, now: Date.now(), env, tokens: { 'epic-pulse.invalid': SENTINEL } });
  assert.equal(outcome.status === 'done' ? outcome.requests : outcome.status, 1);
  assert.deepEqual(chargedHosts(cache), ['epic-pulse.invalid']);
  for (const file of [...filesUnder(paths.dir), ...filesUnder(cache)]) assert.equal(readFileSync(file, 'utf8').includes('SENTINEL'), false, file);
});

// The code tells the two apart: the handed-over token, with a NUL in it, fails
// as invalid_token; the environment's would fail as network.
test('a token the caller hands over comes before the environment and gh', async (t) => {
  const cache = tempDir(t);
  const paths = await boundRegistry(t, [invalid(4)]);
  const env = noGhEnv(t, { GH_ENTERPRISE_TOKEN: 'from-env', EPIC_PULSE_HOSTS: 'epic-pulse.invalid', EPIC_PULSE_CACHE_DIR: cache });
  const outcome = await refresh({ dir: paths.dir, now: Date.now(), env, tokens: { 'epic-pulse.invalid': `${SENTINEL}\u0000x` } });
  assert.deepEqual(outcome, { status: 'done', requests: 1, points: 0, error: 'invalid_token' });
});

// `constructor` is a valid host name and a key every object inherits.
test('only the entries the caller put in the map count, not what every object inherits', async (t) => {
  const paths = await boundRegistry(t, [makeRef({ host: 'constructor', owner: 'acme', repo: 'widgets', number: 4 })!]);
  const outcome = await refresh({ dir: paths.dir, now: Date.now(), env: noGhEnv(t), tokens: {} });
  assert.deepEqual(outcome, { status: 'done', requests: 0, points: 0, error: 'no_token' });
});
