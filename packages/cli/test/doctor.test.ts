import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { writeLimits, type LimitsReading, type LimitWindow } from '@epic-pulse/core';
import { limitsCheck } from '../src/doctor-checks.js';
import { eventPayload } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, tempDir, type Sandbox } from './helpers.js';

const TOKEN = 'SENTINEL-doctor-token-0b9e';

async function doctor(cwd: string, box: Sandbox, extra: NodeJS.ProcessEnv = {}): Promise<ReadonlyMap<string, string>> {
  const run = await runCli(['doctor'], { cwd, env: cliEnv(box, extra) });
  assert.deepEqual([run.code, run.stderr], [0, '']);
  const [title, ...lines] = run.stdout.trimEnd().split('\n');
  assert.equal(title, 'epic-pulse doctor');
  return new Map(lines.map((line) => {
    const [label = '', ...value] = line.trim().split(': ');
    return [label, value.join(': ').trim()] as const;
  }));
}

test('doctor names where the token comes from and never prints the token', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const run = await runCli(['doctor'], { cwd: repo, env: cliEnv(box, { GH_TOKEN: TOKEN }) });
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(TOKEN));
  assert.equal((await doctor(repo, box, { GH_TOKEN: TOKEN })).get('token'), 'from GH_TOKEN');
  assert.match((await doctor(repo, box)).get('token') ?? '', /^none for github\.com: set GH_TOKEN or run `gh auth login`$/);
});

test('doctor reports the repository, its registry and whether the hook has run', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const before = await doctor(repo, box);
  assert.equal(before.get('node'), process.version);
  assert.deepEqual([before.get('repository'), before.get('remote')], [`${repo} (main checkout)`, 'github.com/takauztovies/epic-pulse']);
  assert.equal(before.get('registry'), registryOf(repo).dir);
  assert.match(before.get('hook') ?? '', /^inactive: no hook has written here/);
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: eventPayload('SessionStart', repo) });
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: 'not a payload' });
  const after = await doctor(repo, box);
  assert.match(after.get('hook') ?? '', /^active: last ran \d{4}-\d\d-\d\dT/);
  assert.match(after.get('hook errors') ?? '', /^last: invalid_payload at \d{4}-/);
});

test('doctor reports whether the status line and the runtime copy are installed', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const before = await doctor(repo, box);
  assert.match(before.get('statusLine (user)') ?? '', /^not installed: /);
  assert.match(before.get('runtime') ?? '', /^missing: /);
  assert.equal((await runCli(['statusline', 'install'], { cwd: repo, env: cliEnv(box) })).code, 0);
  const after = await doctor(repo, box);
  assert.match(after.get('statusLine (user)') ?? '', /^installed: /);
  assert.match(after.get('statusLine (project)') ?? '', /^not installed: /);
  assert.match(after.get('runtime') ?? '', /^present, the same build as this one: /);
});

test('doctor outside a repository says so instead of failing', async (t) => {
  const dir = tempDir(t);
  const report = await doctor(dir, sandbox(t));
  assert.deepEqual([report.get('repository'), report.get('registry')], ['not inside a git repository', 'none outside a git repository']);
});

// An entry of EPIC_PULSE_HOSTS that is not a host used to be dropped without a
// word, so a mistyped host looked like a token problem.
test('doctor names every EPIC_PULSE_HOSTS entry it ignores and why, and is silent when every entry is a host', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const listed = async (hosts: string) => {
    const run = await runCli(['doctor'], { cwd: repo, env: cliEnv(box, { EPIC_PULSE_HOSTS: hosts }) });
    assert.deepEqual([run.code, run.stderr], [0, '']);
    return [...run.stdout.matchAll(/^ {2}EPIC_PULSE_HOSTS: +(.*)$/gm)].map((match) => match[1]);
  };
  assert.deepEqual(await listed('ghe.example.com, other.example:8443,'), []);
  assert.deepEqual(await listed('https://ghe.example.com, ok.example.com ,bad_host'), [
    'ignored "https://ghe.example.com": that is a URL; name the host alone, without the scheme or a path',
    'ignored "bad_host": a host name has only letters, digits, dots and hyphens, then an optional :port',
  ]);
});

test('doctor does not print an ignored entry that looks like a token', async (t) => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const run = await runCli(['doctor'], { cwd: demoRepo(t), env: cliEnv(sandbox(t), { EPIC_PULSE_HOSTS: secret }) });
  assert.equal(run.stdout.includes(secret) || run.stderr.includes(secret), false);
  assert.match(run.stdout, /^ {2}EPIC_PULSE_HOSTS: +ignored "\(not shown: it looks like a token\)": a host name has only /m);
});

const HOUR = 3_600_000;
// One five-hour window, written out here and not read from the source, so that a
// changed threshold fails the boundary test instead of moving with it.
const FIVE_HOURS = 5 * HOUR;
const NO_READING = 'no reading yet: Claude Code reports usage only to a terminal status line (2.1.80+, on a paid plan)';
const used = (pct: number): LimitWindow => ({ pct, resetsAt: null });
const reading = (at: number, fiveHour: LimitWindow | null, sevenDay: LimitWindow | null): LimitsReading => ({ v: 1, at, fiveHour, sevenDay });

// A cache directory of its own, holding what a terminal status line would have saved.
async function cacheWith(t: TestContext, saved: LimitsReading): Promise<string> {
  const cache = tempDir(t);
  await writeLimits(cache, saved);
  return cache;
}

// Run from outside a repository: nothing else `doctor` reports matters here.
async function usageLine(t: TestContext, cache: string): Promise<string | undefined> {
  return (await doctor(tempDir(t), sandbox(t), { EPIC_PULSE_CACHE_DIR: cache })).get('usage limit');
}

// Only a terminal status line is ever handed the usage (the VS Code panel and the
// Desktop app run none), so a session with no terminal beside it has no reading:
// a fact to report, not a fault. `doctor` still exits 0 with nothing on stderr.
test('doctor says no usage reading has arrived, for an empty cache and for a damaged file alike', async (t) => {
  assert.equal(await usageLine(t, tempDir(t)), NO_READING);
  const damaged = tempDir(t);
  writeFileSync(join(damaged, 'limits.json'), '{"v":1,"at":');
  assert.equal(await usageLine(t, damaged), NO_READING);
});

test('doctor shows when the usage was last read and each window it reported, leaving out one it did not', async (t) => {
  const at = Date.now() - HOUR; // older than the ten minutes the prompt hook trusts a reading, well inside the five hours doctor does
  const when = new Date(at).toISOString();
  const line = async (five: LimitWindow | null, seven: LimitWindow | null) => usageLine(t, await cacheWith(t, reading(at, five, seven)));
  assert.equal(await line(used(42), used(12)), `last reading ${when} (5h 42%, 7d 12%)`);
  assert.equal(await line(used(91.9), null), `last reading ${when} (5h 91%)`, 'a whole percent, cut as the status line cuts it');
  assert.equal(await line(null, used(12)), `last reading ${when} (7d 12%)`);
  assert.equal(await line(null, null), `last reading ${when}`, 'no empty brackets');
});

test('doctor calls a reading from before the last five hours stale, and quotes no percentages from it', async (t) => {
  const at = Date.now() - 6 * HOUR;
  const cache = await cacheWith(t, reading(at, used(97), used(60)));
  assert.equal(await usageLine(t, cache), `stale: last reading ${new Date(at).toISOString()}`);
});

// The tests above run the built program, which reads its own clock, so none can
// land on the boundary: `now` is an argument of the check, and is given here.
test('a reading is stale only once it is older than one five-hour window', async (t) => {
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  const at = now - FIVE_HOURS;
  const env = { EPIC_PULSE_CACHE_DIR: await cacheWith(t, reading(at, used(42), null)) };
  const when = new Date(at).toISOString();
  assert.deepEqual(await limitsCheck(env, now), ['usage limit', `last reading ${when} (5h 42%)`], 'exactly one window old');
  assert.deepEqual(await limitsCheck(env, now + 1), ['usage limit', `stale: last reading ${when}`]);
});
