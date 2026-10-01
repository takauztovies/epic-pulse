import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { statusPayload } from './fixtures.js';
import { BUNDLE, cliEnv, runCli, sandbox, sha256, tempDir, type CliRun, type Sandbox } from './helpers.js';

const ORIGINAL = '{\n  "model": "opus",\n  "env": {\n    "EXAMPLE": "1"\n  },\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n';
const SHARED_COMMAND = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/epic-pulse/runtime.mjs" statusline';

const settingsOf = (box: Sandbox) => join(box.config, 'settings.json');
const runtimeOf = (box: Sandbox) => join(box.config, 'epic-pulse', 'runtime.mjs');
const backupsOf = (file: string) => readdirSync(dirname(file)).filter((name) => name.includes('.epic-pulse-') && name.endsWith('.bak'));

function withSettings(box: Sandbox, text: string): string {
  writeFileSync(settingsOf(box), text);
  return sha256(settingsOf(box));
}

function withoutConfigDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'CLAUDE_CONFIG_DIR'));
}

function install(box: Sandbox, args: readonly string[] = [], cwd = box.home): Promise<CliRun> {
  return runCli(['statusline', 'install', ...args], { cwd, env: cliEnv(box) });
}

test('--dry-run leaves the settings byte for byte as they were and writes nothing at all', async (t) => {
  const box = sandbox(t);
  const before = withSettings(box, ORIGINAL);
  const run = await install(box, ['--dry-run']);
  assert.equal(sha256(settingsOf(box)), before);
  assert.deepEqual(readdirSync(box.config), ['settings.json']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /dry run, nothing was written/);
  assert.match(run.stdout, /\+ "statusLine": /);
});

test('install adds only statusLine, copies the runtime, and keeps a backup that restores exactly', async (t) => {
  const box = sandbox(t);
  const before = withSettings(box, ORIGINAL);
  const run = await install(box);
  assert.deepEqual([run.code, run.stderr], [0, '']);
  const next = JSON.parse(readFileSync(settingsOf(box), 'utf8')) as Record<string, unknown>;
  const command = `node "${runtimeOf(box)}" statusline`;
  assert.deepEqual(next, { ...(JSON.parse(ORIGINAL) as object), statusLine: { type: 'command', command, refreshInterval: 30 } });
  assert.equal(sha256(runtimeOf(box)), sha256(BUNDLE));
  const [backup, ...extra] = backupsOf(settingsOf(box));
  assert.ok(backup !== undefined && extra.length === 0, 'exactly one backup');
  assert.equal(sha256(join(box.config, backup)), before);
  copyFileSync(join(box.config, backup), settingsOf(box));
  assert.equal(sha256(settingsOf(box)), before);
});

test('a second install changes nothing', async (t) => {
  const box = sandbox(t);
  withSettings(box, ORIGINAL);
  assert.equal((await install(box)).code, 0);
  const installed = sha256(settingsOf(box));
  const again = await install(box);
  assert.deepEqual([again.code, again.stderr], [0, '']);
  assert.match(again.stdout, /already installed/);
  assert.equal(sha256(settingsOf(box)), installed);
  assert.equal(backupsOf(settingsOf(box)).length, 1);
});

test('an existing statusLine that is not ours is refused and shown, never replaced', async (t) => {
  const box = sandbox(t);
  const theirs = { type: 'command', command: 'my-status.sh' };
  const before = withSettings(box, `${JSON.stringify({ statusLine: theirs }, null, 2)}\n`);
  const run = await install(box);
  assert.equal(sha256(settingsOf(box)), before);
  assert.deepEqual([existsSync(runtimeOf(box)), backupsOf(settingsOf(box))], [false, []]);
  assert.deepEqual([run.code, run.stdout], [1, '']);
  assert.match(run.stderr, new RegExp(`- "statusLine": ${JSON.stringify(theirs).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('settings that do not parse abort the install and stay untouched', async (t) => {
  const box = sandbox(t);
  const before = withSettings(box, '{\n  "model": "opus",\n}\n');
  const run = await install(box);
  assert.equal(sha256(settingsOf(box)), before);
  assert.deepEqual(readdirSync(box.config), ['settings.json']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /is not a JSON object, so it was left unchanged/);
});

test('--project writes ./.claude/settings.json with the shared runtime path and leaves user settings alone', async (t) => {
  const box = sandbox(t);
  const project = tempDir(t);
  const run = await install(box, ['--project'], project);
  assert.equal(run.code, 0);
  const next = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(next, { statusLine: { type: 'command', command: SHARED_COMMAND, refreshInterval: 30 } });
  assert.equal(existsSync(settingsOf(box)), false);
});

test('without CLAUDE_CONFIG_DIR the user settings are ~/.claude/settings.json', async (t) => {
  const box = sandbox(t);
  const home = join(box.home, 'elsewhere');
  mkdirSync(home);
  const env = withoutConfigDir(cliEnv(box, { HOME: home, USERPROFILE: home }));
  const run = await runCli(['statusline', 'install'], { cwd: home, env });
  assert.equal(run.code, 0);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
  assert.equal(sha256(join(home, '.claude', 'epic-pulse', 'runtime.mjs')), sha256(BUNDLE));
});

// Claude Code runs the command through a shell; so does this.
test('both installed commands run the runtime copy and print a status line', { skip: process.platform === 'win32' && 'no POSIX sh' }, async (t) => {
  const box = sandbox(t);
  const project = tempDir(t);
  await install(box);
  await install(box, ['--project'], project);
  const shared = join(project, '.claude', 'settings.json');
  const env = { ...cliEnv(box), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  // The shared command finds the runtime through CLAUDE_CONFIG_DIR, or through
  // $HOME/.claude when that is unset, which in the sandbox is the same place.
  for (const [file, shellEnv] of [[settingsOf(box), env], [shared, env], [shared, withoutConfigDir(env)]] as const) {
    const { statusLine } = JSON.parse(readFileSync(file, 'utf8')) as { statusLine: { command: string } };
    const out = execFileSync('sh', ['-c', statusLine.command], { cwd: project, env: shellEnv, input: statusPayload(project), encoding: 'utf8' });
    assert.equal(out, 'epic-pulse: no epic\n', file);
  }
});
