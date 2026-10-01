import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, readPins, refKey, sessionFile, type RegistryPaths } from '@epic-pulse/core';
import { bashPayload, demo, eventPayload } from './fixtures.js';
import { cliEnv, demoRepo, git, registryOf, runCli, sandbox, SESSION, tempDir } from './helpers.js';

async function pinned(paths: RegistryPaths): Promise<readonly string[]> {
  const read = await readPins(paths);
  return read.status === 'ok' ? read.pins.map((pin) => refKey(pin.ref)) : [read.status];
}

test('inside Claude Code, track writes nothing: the hook pins the issue to the session that ran it', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t), { CLAUDECODE: '1' });
  const run = await runCli(['track', '8'], { cwd: repo, env });
  assert.equal(existsSync(registryOf(repo).dir), false);
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.deepEqual([run.code, run.stdout.split('\n')[0]], [0, 'epic-pulse: the hook pins 8 to this session.']);
  assert.match(run.stderr, /no epic-pulse hook has run here/);
  // What the hook then records for that very command line.
  await runCli(['hook'], { cwd: repo, env, input: bashPayload('epic-pulse track 8', repo) });
  const lines = parseLines(readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8'));
  assert.deepEqual(lines.flatMap((line) => line.binds.map((bind) => `${bind.via}:${refKey(bind.ref)}`)), [`pin:${refKey(demo(8))}`]);
  assert.equal(existsSync(registryOf(repo).pinsFile), false);
});

test('inside Claude Code with the hook active there is no warning, and --repo writes the repository pin', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t), { CLAUDECODE: '1' });
  await runCli(['hook'], { cwd: repo, env, input: eventPayload('SessionStart', repo) });
  const quiet = await runCli(['untrack', '8'], { cwd: repo, env });
  assert.deepEqual([quiet.code, quiet.stderr], [0, '']);
  assert.match(quiet.stdout, /the hook unpins 8 from this session/);
  const run = await runCli(['track', '8', '--repo'], { cwd: repo, env });
  assert.deepEqual([run.code, run.stdout], [0, `epic-pulse: pinned ${refKey(demo(8))} for this repository.\n`]);
  assert.deepEqual(await pinned(registryOf(repo)), [refKey(demo(8))]);
});

test('outside Claude Code, track and untrack change the repository pins, idempotently', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  const say = async (args: readonly string[]) => (await runCli(args, { cwd: repo, env })).stdout.trim();
  const key = refKey(demo(8));
  assert.equal(await say(['track', '#8']), `epic-pulse: pinned ${key} for this repository.`);
  assert.equal(await say(['track', '8']), `epic-pulse: ${key} was already pinned.`);
  assert.deepEqual(await pinned(registryOf(repo)), [key]);
  assert.equal(await say(['untrack', '8']), `epic-pulse: unpinned ${key}.`);
  assert.equal(await say(['untrack', '8']), `epic-pulse: ${key} was not pinned.`);
  assert.deepEqual(await pinned(registryOf(repo)), []);
});

test('a target may name its repository or be an issue URL', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  await runCli(['track', 'takauztovies/epic-pulse#8'], { cwd: repo, env });
  await runCli(['track', 'https://github.com/takauztovies/epic-pulse/issues/1'], { cwd: repo, env });
  assert.deepEqual(await pinned(registryOf(repo)), [refKey(demo(8)), refKey(demo(1))]);
});

test('an unreadable target, a repository without a remote and a corrupt pins.json are refused', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  const bad = await runCli(['track', 'not-an-issue'], { cwd: repo, env });
  assert.deepEqual([bad.code, bad.stdout], [2, '']);
  assert.match(bad.stderr, /^usage: epic-pulse track/);
  git(repo, ['remote', 'remove', 'origin']);
  const bare = await runCli(['track', '8'], { cwd: repo, env });
  assert.deepEqual([bare.code, bare.stderr], [1, 'epic-pulse: this repository has no GitHub remote; name one as owner/repo#N\n']);
  const corrupt = '{"v":1,"pins":[';
  mkdirSync(registryOf(repo).dir, { recursive: true });
  writeFileSync(registryOf(repo).pinsFile, corrupt);
  assert.equal((await runCli(['track', 'takauztovies/epic-pulse#8'], { cwd: repo, env })).code, 1);
  assert.equal(readFileSync(registryOf(repo).pinsFile, 'utf8'), corrupt);
});

test('outside any repository track refuses and writes nothing', async (t) => {
  const dir = tempDir(t);
  const run = await runCli(['track', 'takauztovies/epic-pulse#8'], { cwd: dir, env: cliEnv(sandbox(t)) });
  assert.deepEqual([run.code, run.stderr], [1, 'epic-pulse: not inside a git repository\n']);
});
