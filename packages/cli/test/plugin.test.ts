import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { parseLines, refKey, sessionFile } from '@epic-pulse/core';
import { bashPayload, demo, eventPayload } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, ROOT, runCli, sandbox, SESSION, sha256, type Sandbox } from './helpers.js';

const PLUGIN = join(ROOT, 'plugin');
const NO_SH = process.platform === 'win32' && 'needs a POSIX sh; Windows is checked by hand';

const HookSchema = z.object({ type: z.literal('command'), command: z.string(), async: z.boolean().optional(), timeout: z.number() });
const HooksFileSchema = z.object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(HookSchema) }))) });
const NamedSchema = z.object({ name: z.string(), version: z.string() });
const MarketplaceSchema = z.object({ name: z.string(), plugins: z.array(NamedSchema.extend({ source: z.string() })) });

const json = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const hooks = HooksFileSchema.parse(json('plugin/hooks/hooks.json')).hooks;

function hook(event: string): z.infer<typeof HookSchema> {
  const found = hooks[event]?.[0]?.hooks[0];
  assert.ok(found, `no ${event} hook`);
  return found;
}

// Only node and dirname on the PATH, never `gh`: a hook stays offline anyway,
// and nothing here may find a real token.
function shellEnv(box: Sandbox): NodeJS.ProcessEnv {
  symlinkSync(process.execPath, join(box.bin, 'node'));
  symlinkSync('/usr/bin/dirname', join(box.bin, 'dirname'));
  return { ...cliEnv(box), CLAUDE_PLUGIN_ROOT: PLUGIN };
}

test('the plugin, its marketplace entry and the npm package agree on name and version', () => {
  const cli = NamedSchema.parse(json('packages/cli/package.json'));
  const plugin = NamedSchema.parse(json('plugin/.claude-plugin/plugin.json'));
  const [entry, ...others] = MarketplaceSchema.parse(json('.claude-plugin/marketplace.json')).plugins;
  assert.ok(entry, 'the marketplace lists no plugin');
  assert.deepEqual([plugin.name, plugin.version, others.length], ['epic-pulse', cli.version, 0]);
  assert.deepEqual([entry.name, entry.version, entry.source], ['epic-pulse', cli.version, './plugin']);
  assert.equal(NamedSchema.parse(json(join(entry.source, '.claude-plugin', 'plugin.json'))).name, entry.name);
});

test('PostToolUse fires, asynchronously, on the tools that change things and on no others', () => {
  const post = hooks['PostToolUse']?.[0];
  const matcher = new RegExp(`^(?:${post?.matcher ?? ''})$`);
  assert.deepEqual(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].filter((tool) => !matcher.test(tool)), []);
  assert.deepEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'Task', 'TodoWrite'].filter((tool) => matcher.test(tool)), []);
  assert.deepEqual([hook('PostToolUse').async, hook('PostToolUse').timeout], [true, 5]);
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart']);
});

test('each hook command does its job when a shell runs it the way Claude Code does', { skip: NO_SH }, (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const env = shellEnv(box);
  const calls = [['SessionStart', eventPayload('SessionStart', repo)], ['PostToolUse', bashPayload('gh issue comment 4 -b hi', repo)],
    ['SessionEnd', eventPayload('SessionEnd', repo)]] as const;
  for (const [event, input] of calls) {
    const run = spawnSync('/bin/sh', ['-c', hook(event).command], { cwd: repo, env, input, encoding: 'utf8' });
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], event);
  }
  assert.equal(sha256(join(box.config, 'epic-pulse', 'runtime.mjs')), sha256(join(PLUGIN, 'dist', 'epic-pulse.mjs')));
  const lines = parseLines(readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8'));
  assert.deepEqual(lines.map((line) => line.ev), ['start', 'tool', 'end']);
  assert.deepEqual(lines[1]?.binds.map((bind) => refKey(bind.ref)), [refKey(demo(4))]);
});

test('the bin shims start the plugin bundle', { skip: NO_SH }, (t) => {
  const shim = join(PLUGIN, 'bin', 'epic-pulse');
  assert.notEqual(statSync(shim).mode & 0o111, 0, 'the sh shim must be executable');
  const run = spawnSync(shim, ['--help'], { cwd: ROOT, env: shellEnv(sandbox(t)), encoding: 'utf8' });
  assert.deepEqual([run.status, run.stdout.split('\n')[0]], [0, 'usage: epic-pulse <command>']);
  const cmd = readFileSync(join(PLUGIN, 'bin', 'epic-pulse.cmd'), 'utf8');
  assert.match(cmd, /^@echo off\r\n(?:.*\r\n)*node "%~dp0\.\.\\dist\\epic-pulse\.mjs" %\*\r\n$/);
});

test('the track skill runs the one command line the hook turns into a session pin', async (t) => {
  const skill = readFileSync(join(PLUGIN, 'skills', 'track', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: track\ndescription: .+\n/);
  const command = /```sh\n(.+)\n```/.exec(skill)?.[1];
  assert.equal(command, 'epic-pulse track $ARGUMENTS');
  const repo = demoRepo(t);
  await runCli(['hook'], { cwd: repo, env: cliEnv(sandbox(t)), input: bashPayload(command.replace('$ARGUMENTS', '8'), repo) });
  const lines = parseLines(readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8'));
  assert.deepEqual(lines.flatMap((line) => line.binds.map((bind) => `${bind.via}:${refKey(bind.ref)}`)), [`pin:${refKey(demo(8))}`]);
});
