import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { appendRegistryLine, readSnapshot, sessionFile, writeSnapshot, type RegistryPaths } from '@epic-pulse/core';
import { bashPayload, demo, demoSnapshot, eventPayload, statusPayload } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, SESSION, tempDir, waitFor, type CliRun, type Sandbox } from './helpers.js';

const OTHER_SESSION = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
const CANARY_SESSION = '2b3c4d5e-6f7a-4b1c-8d2e-3f4a5b6c7d8e';
const EPIC_LINE = '#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2';
const ELEVEN_MINUTES = 11 * 60 * 1000;
const EIGHT_DAYS_S = 8 * 24 * 60 * 60;

interface Bound {
  readonly repo: string;
  readonly box: Sandbox;
  readonly paths: RegistryPaths;
}

// A session that started and then commented on demo sub-issue #4, both
// recorded by the real hook.
async function boundSession(t: TestContext): Promise<Bound> {
  const repo = demoRepo(t);
  const box = sandbox(t);
  for (const input of [eventPayload('SessionStart', repo), bashPayload('gh issue comment 4 -b hi', repo)]) {
    assert.equal((await runCli(['hook'], { cwd: repo, env: cliEnv(box), input })).code, 0);
  }
  return { repo, box, paths: registryOf(repo) };
}

async function statusLine(where: Pick<Bound, 'repo' | 'box'>, input = statusPayload(where.repo)): Promise<CliRun> {
  const run = await runCli(['statusline'], { cwd: where.repo, env: cliEnv(where.box), input });
  assert.deepEqual([run.code, run.stderr], [0, '']);
  return run;
}

// A session file untouched for eight days. Pruning it is the refresher's last
// step before it releases the lock, so once it and the lock are gone a
// refresh has run to the end; while it stays, none has.
function plantCanary(paths: RegistryPaths): string {
  const file = sessionFile(paths, CANARY_SESSION)!;
  mkdirSync(paths.sessionsDir, { recursive: true });
  writeFileSync(file, '');
  const then = Date.now() / 1000 - EIGHT_DAYS_S;
  utimesSync(file, then, then);
  return file;
}

async function refreshFinished(paths: RegistryPaths, canary: string): Promise<void> {
  assert.ok(await waitFor(() => !existsSync(canary) && !existsSync(paths.lockFile)), 'no detached refresh ran to the end');
}

// The sandbox has no token and no `gh`, so a refresh ends by recording that.
async function snapshotError(paths: RegistryPaths): Promise<unknown> {
  const read = await readSnapshot(paths.snapshotFile);
  return read.status === 'ok' ? read.snapshot.error : read.status;
}

test('a fresh snapshot renders the session\'s epic from disk and starts no refresh', async (t) => {
  const bound = await boundSession(t);
  await writeSnapshot(bound.paths.snapshotFile, demoSnapshot(Date.now()));
  const canary = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, `${EPIC_LINE}\n`);
  // A spawned refresh would prune the canary within this second; none may.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(canary), true);
});

// The refresh recorded its failure, so a render inside the minute after it
// starts none: without the record every render started one more.
async function noRefreshStarts(canary: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(canary), true, 'a render started a refresh inside the minute after one failed');
}

test('a missing snapshot shows loading, and the detached refresh records why it could not fetch', async (t) => {
  const bound = await boundSession(t);
  const first = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, 'epic-pulse: loading…\n');
  await refreshFinished(bound.paths, first);
  assert.equal(await snapshotError(bound.paths), 'no_token');
  const second = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, 'epic-pulse: error (no_token)\n');
  await noRefreshStarts(second);
});

test('a minute after a refresh failed, the next render starts another', async (t) => {
  const bound = await boundSession(t);
  mkdirSync(bound.paths.dir, { recursive: true });
  writeFileSync(join(bound.paths.dir, 'refresh-attempt.json'), JSON.stringify({ v: 1, at: Date.now() - 61_000, code: 'no_token' }));
  const canary = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, 'epic-pulse: loading…\n');
  await refreshFinished(bound.paths, canary);
});

test('a corrupt snapshot shows loading and is replaced by the refresh', async (t) => {
  const bound = await boundSession(t);
  writeFileSync(bound.paths.snapshotFile, '{"v":1,"updatedAt":');
  const canary = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, 'epic-pulse: loading…\n');
  await refreshFinished(bound.paths, canary);
  assert.equal(await snapshotError(bound.paths), 'no_token');
});

// A refresh without a token has learned nothing about the epic, so it leaves
// the epic as it was: stale by age, with no error of its own.
test('a stale snapshot still shows the epic, marked stale, and a refresh without a token leaves it so', async (t) => {
  const bound = await boundSession(t);
  await writeSnapshot(bound.paths.snapshotFile, demoSnapshot(Date.now() - ELEVEN_MINUTES));
  const first = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, `${EPIC_LINE} · stale\n`);
  await refreshFinished(bound.paths, first);
  assert.equal(await snapshotError(bound.paths), 'no_token');
  const second = plantCanary(bound.paths);
  assert.equal((await statusLine(bound)).stdout, `${EPIC_LINE} · stale\n`);
  await noRefreshStarts(second);
});

// The hook writes with the real clock, so the quiet session's line is
// written directly, as the hook would have three hours ago.
test('a session quiet for three hours still has its issue refreshed while its status line renders', async (t) => {
  const repo = demoRepo(t);
  const paths = registryOf(repo);
  const binds = [{ ref: demo(4), via: 'gh' as const }];
  assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: Date.now() - 3 * 60 * 60 * 1000, ev: 'tool', binds })).ok);
  const canary = plantCanary(paths);
  assert.equal((await statusLine({ repo, box: sandbox(t) })).stdout, 'epic-pulse: loading…\n');
  await refreshFinished(paths, canary);
  assert.equal(await snapshotError(paths), 'no_token', 'the refresh never asked about the quiet session\'s issue');
});

test('a session the hook never wrote for, or no session at all, is hook-inactive', async (t) => {
  const bound = await boundSession(t);
  await writeSnapshot(bound.paths.snapshotFile, demoSnapshot(Date.now()));
  for (const input of [statusPayload(bound.repo, OTHER_SESSION), '', 'not json', '{"session_id":"../../etc"}']) {
    assert.equal((await statusLine(bound, input)).stdout, 'epic-pulse: hook inactive\n', input);
  }
});

test('outside a repository there is no epic to show', async (t) => {
  const dir = tempDir(t);
  assert.equal((await statusLine({ repo: dir, box: sandbox(t) })).stdout, 'epic-pulse: no epic\n');
});

// A mistyped host is for doctor and the VS Code details to say. The status line
// is redrawn every thirty seconds, from disk, and stays as quiet as it was.
test('the status line says nothing about an ignored EPIC_PULSE_HOSTS entry', async (t) => {
  const bound = await boundSession(t);
  const plain = await statusLine(bound);
  const env = cliEnv(bound.box, { EPIC_PULSE_HOSTS: 'https://ghe.example.com,bad_host' });
  const run = await runCli(['statusline'], { cwd: bound.repo, env, input: statusPayload(bound.repo) });
  assert.deepEqual([run.code, run.stdout, run.stderr], [0, plain.stdout, '']);
  assert.doesNotMatch(run.stdout, /EPIC_PULSE_HOSTS|ignored/);
});
