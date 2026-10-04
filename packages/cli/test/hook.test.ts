import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLines, refKey, RegistryLineSchema, sessionFile } from '@epic-pulse/core';
import { bashPayload, demo, eventPayload } from './fixtures.js';
import { BUNDLE, cliEnv, demoRepo, registryOf, runCli, sandbox, SESSION, sha256, tempDir } from './helpers.js';

const SENTINEL = 'SENTINEL-4d1c-never-stored';

function logCodes(repo: string): readonly string[] {
  const file = join(registryOf(repo).dir, 'hook.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { code: string }).code) : [];
}

test('32 concurrent hook processes leave exactly 32 valid registry lines', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  const input = bashPayload('gh issue comment 4 -b hi', repo);
  const runs = await Promise.all(Array.from({ length: 32 }, () => runCli(['hook'], { cwd: repo, env, input })));
  assert.deepEqual(runs.map((run) => [run.code, run.stdout, run.stderr]), runs.map(() => [0, '', '']));
  const raw = readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8').split('\n').filter(Boolean);
  assert.equal(raw.length, 32);
  for (const line of raw) {
    const parsed = RegistryLineSchema.parse(JSON.parse(line));
    assert.deepEqual(parsed.binds.map((bind) => `${bind.via}:${refKey(bind.ref)}`), [`gh:${refKey(demo(4))}`]);
  }
  assert.equal(parseLines(raw.join('\n')).length, 32);
});

test('the hook exits 0 and prints nothing, whatever arrives on stdin', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  const huge = 'x'.repeat(20 * 1024 * 1024);
  const hugeJson = JSON.stringify({ session_id: SESSION, cwd: repo, tool_name: 'Write', tool_input: { file_path: join(repo, 'a'), content: huge } });
  const inputs = ['', `not json ${SENTINEL}`, '{"session_id": 5}', '[]', 'null', `{"cwd": "${SENTINEL}"}`, huge, hugeJson];
  for (const input of inputs) {
    const run = await runCli(['hook'], { cwd: repo, env, input });
    assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', ''], input.slice(0, 40));
  }
  assert.equal(existsSync(registryOf(repo).sessionsDir), false);
  assert.deepEqual(logCodes(repo), [...Array<string>(6).fill('invalid_payload'), 'payload_too_large', 'payload_too_large']);
  assert.doesNotMatch(readFileSync(join(registryOf(repo).dir, 'hook.log'), 'utf8'), new RegExp(SENTINEL));
});

test('a registry that can not be written still means exit 0 and an empty stdout', async (t) => {
  const repo = demoRepo(t);
  writeFileSync(registryOf(repo).dir, 'a file where the registry directory belongs');
  const run = await runCli(['hook'], { cwd: repo, env: cliEnv(sandbox(t)), input: bashPayload('gh issue close 4', repo) });
  assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', '']);
});

test('the hook stores refs and timestamps, never the command or its text', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  await runCli(['hook'], { cwd: repo, env, input: bashPayload(`gh issue comment 4 -b "${SENTINEL}"`, repo) });
  const text = readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8');
  assert.doesNotMatch(text, new RegExp(`${SENTINEL}|comment|${repo.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ['binds', 'ev', 'ts', 'unbinds', 'v']);
});

test('SessionStart records the start and copies the bundle to the runtime path once', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const runtime = join(box.config, 'epic-pulse', 'runtime.mjs');
  const first = await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: eventPayload('SessionStart', repo) });
  assert.deepEqual([first.code, first.stdout], [0, '']);
  assert.equal(sha256(runtime), sha256(BUNDLE));
  const copiedAt = statSync(runtime).mtimeMs;
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: eventPayload('SessionStart', repo) });
  assert.equal(statSync(runtime).mtimeMs, copiedAt);
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: eventPayload('SessionEnd', repo) });
  const events = parseLines(readFileSync(sessionFile(registryOf(repo), SESSION)!, 'utf8')).map((line) => line.ev);
  assert.deepEqual(events, ['start', 'start', 'end']);
});

test('outside a repository the hook writes nothing anywhere', async (t) => {
  const dir = tempDir(t);
  const box = sandbox(t);
  const run = await runCli(['hook'], { cwd: dir, env: cliEnv(box), input: bashPayload('gh issue close 4', dir) });
  assert.deepEqual([run.code, run.stdout, run.stderr], [0, '', '']);
  assert.deepEqual([readdirSync(dir), readdirSync(box.config)], [[], []]);
});

test('the error log is capped: past 64 KiB it moves aside and starts again', async (t) => {
  const repo = demoRepo(t);
  const log = join(registryOf(repo).dir, 'hook.log');
  await runCli(['hook'], { cwd: repo, env: cliEnv(sandbox(t)), input: 'garbage' });
  writeFileSync(log, `${'{"ts":1,"code":"io"}\n'.repeat(3300)}`);
  await runCli(['hook'], { cwd: repo, env: cliEnv(sandbox(t)), input: 'garbage' });
  assert.deepEqual(logCodes(repo), ['invalid_payload']);
  assert.equal(statSync(`${log}.1`).size, 21 * 3300);
});
