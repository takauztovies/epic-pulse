import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireLock, JsonV1Schema, readSnapshot, releaseLock, writeSnapshot } from '@epic-pulse/core';
import { bashPayload, demoSnapshot } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, tempDir } from './helpers.js';

test('json prints the v1 view of every live session and the pins, for the repository --cwd names', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  await runCli(['hook'], { cwd: repo, env, input: bashPayload('gh issue comment 4 -b hi', repo) });
  assert.equal((await runCli(['track', '8'], { cwd: repo, env })).code, 0);
  await writeSnapshot(registryOf(repo).snapshotFile, demoSnapshot(Date.now()));
  const run = await runCli(['json', '--cwd', repo], { cwd: tempDir(t), env });
  assert.deepEqual([run.code, run.stderr], [0, '']);
  const view = JsonV1Schema.parse(JSON.parse(run.stdout));
  assert.deepEqual([view.snapshot.state, view.liveSessions, view.epics.map((epic) => epic.number)], ['ok', 1, [1, 8]]);
  const four = view.epics[0]?.children.find((child) => child.number === 4);
  assert.equal(four?.sessionCount, 1);
});

test('json outside a repository, or with an unknown option, fails without printing JSON', async (t) => {
  const env = cliEnv(sandbox(t));
  const outside = await runCli(['json'], { cwd: tempDir(t), env });
  assert.deepEqual([outside.code, outside.stdout, outside.stderr], [1, '', 'epic-pulse: not inside a git repository\n']);
  const unknown = await runCli(['json', '--bogus'], { cwd: demoRepo(t), env });
  assert.deepEqual([unknown.code, unknown.stdout], [2, '']);
  assert.match(unknown.stderr, /^usage: epic-pulse json/);
});

test('refresh without a token records no_token in the snapshot and exits 1', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  await runCli(['hook'], { cwd: repo, env, input: bashPayload('gh issue comment 4 -b hi', repo) });
  const run = await runCli(['refresh'], { cwd: repo, env });
  assert.deepEqual([run.code, run.stdout], [1, 'epic-pulse: refreshed with 0 request(s) and 0 point(s).\n']);
  assert.equal(run.stderr, 'epic-pulse: the refresh stopped early (no_token)\n');
  const read = await readSnapshot(registryOf(repo).snapshotFile);
  assert.equal(read.status === 'ok' ? read.snapshot.error : read.status, 'no_token');
});

test('refresh leaves a running refresh alone and says so', async (t) => {
  const repo = demoRepo(t);
  const lock = await acquireLock(registryOf(repo).lockFile, { now: Date.now(), staleMs: 60_000 });
  assert.ok(lock);
  t.after(() => releaseLock(lock));
  const run = await runCli(['refresh'], { cwd: repo, env: cliEnv(sandbox(t)) });
  assert.deepEqual([run.code, run.stdout], [0, 'epic-pulse: another refresh is running; leaving it to finish.\n']);
});
