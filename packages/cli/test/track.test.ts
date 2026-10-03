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

// The hook finds its pin by the command's name, and a launcher word in front of
// it (npx, pnpm exec) hides the name, so the command would pin nothing. npx and
// pnpm exec both set npm_command=exec for what they start.
test('inside Claude Code, a command started through npx or pnpm exec is warned about, claims no pin and writes nothing', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t), { CLAUDECODE: '1', npm_command: 'exec' });
  for (const verb of ['track', 'untrack'] as const) {
    const run = await runCli([verb, '8'], { cwd: repo, env });
    const [pin, from] = verb === 'track' ? ['pin', 'to'] : ['unpin', 'from'];
    assert.deepEqual([run.code, run.stdout], [0, ''], verb);
    assert.equal(
      run.stderr,
      `epic-pulse: this looks like it was started through npx or pnpm exec, which the hook can not read, so it will not ${pin} 8 ${from} this session.\n` +
        `epic-pulse: nothing was written. Run it as \`epic-pulse ${verb} 8\`, or add --repo to change the pin for the whole repository.\n`,
    );
  }
  assert.equal(existsSync(registryOf(repo).dir), false);
});

test('a launcher costs nothing where the hook is not involved: --repo, outside Claude Code, and an npm script that is not a launcher', async (t) => {
  const repo = demoRepo(t);
  const key = refKey(demo(8));
  const viaRepo = await runCli(['track', '8', '--repo'], { cwd: repo, env: cliEnv(sandbox(t), { CLAUDECODE: '1', npm_command: 'exec' }) });
  assert.deepEqual([viaRepo.code, viaRepo.stdout, viaRepo.stderr], [0, `epic-pulse: pinned ${key} for this repository.\n`, '']);
  const outside = await runCli(['untrack', '8'], { cwd: repo, env: cliEnv(sandbox(t), { npm_command: 'exec' }) });
  assert.deepEqual([outside.code, outside.stdout, outside.stderr], [0, `epic-pulse: unpinned ${key}.\n`, '']);
  const script = await runCli(['track', '8'], { cwd: repo, env: cliEnv(sandbox(t), { CLAUDECODE: '1', npm_command: 'run-script' }) });
  assert.equal(script.stdout.split('\n')[0], 'epic-pulse: the hook pins 8 to this session.');
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
