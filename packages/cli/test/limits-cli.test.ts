import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { eventPayload, statusPayload } from './fixtures.js';
import { cliEnv, demoRepo, runCli, sandbox, SESSION, tempDir } from './helpers.js';

// The built CLI, as Claude Code runs it: the status line reads the account's
// usage from its own payload and warns at 90%; the prompt hook then tells the
// session's agent once, from the reading the status line saved.
const ESC = String.fromCharCode(27);
const visible = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const resetsAt = () => Math.round(Date.now() / 1000) + 2 * 3600;

function scene(t: TestContext, extra: NodeJS.ProcessEnv = {}) {
  const cache = tempDir(t);
  return { repo: demoRepo(t), cache, env: cliEnv(sandbox(t), { EPIC_PULSE_CACHE_DIR: cache, ...extra }) };
}

function withLimits(repo: string, pct: number): string {
  return JSON.stringify({ ...JSON.parse(statusPayload(repo)), rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt() }, seven_day: { used_percentage: 12, resets_at: resetsAt() + 86400 } } });
}

const prompt = (repo: string, session = SESSION) => JSON.stringify({ ...JSON.parse(eventPayload('SessionStart', repo, session)), hook_event_name: 'UserPromptSubmit', prompt: 'next step' });

test('the status line warns in red at 90%, keeps within 80 characters, and says nothing below it', async (t) => {
  const { repo, env } = scene(t);
  const warned = (await runCli(['statusline'], { cwd: repo, env, input: withLimits(repo, 91) })).stdout.trimEnd();
  assert.ok(warned.startsWith(`${ESC}[1;31m⚠ 91% 5h limit`), warned);
  assert.ok(visible(warned).length <= 80, visible(warned));
  assert.match(visible(warned), /^⚠ 91% 5h limit, resets in \dh\d\dm · \/compact · epic-pulse: /);
  const calm = (await runCli(['statusline'], { cwd: repo, env, input: withLimits(repo, 89) })).stdout;
  assert.ok(!calm.includes('⚠') && !calm.includes(ESC), calm);
});

test('NO_COLOR keeps the warning and drops the colour', async (t) => {
  const { repo, env } = scene(t, { NO_COLOR: '1' });
  const line = (await runCli(['statusline'], { cwd: repo, env, input: withLimits(repo, 95) })).stdout;
  assert.ok(line.startsWith('⚠ 95% 5h limit') && !line.includes(ESC), line);
});

test('the prompt hook tells the session once, as context for the model, and nothing on other events', async (t) => {
  const { repo, cache, env } = scene(t);
  await runCli(['statusline'], { cwd: repo, env, input: withLimits(repo, 92) });
  assert.ok(existsSync(join(cache, 'limits.json')), 'the status line saved the reading');
  const first = await runCli(['hook'], { cwd: repo, env, input: prompt(repo) });
  assert.equal(first.code, 0);
  const output = JSON.parse(first.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /^epic-pulse: this Claude account is at 92% of the 5-hour usage limit/);
  assert.deepEqual([(await runCli(['hook'], { cwd: repo, env, input: prompt(repo) })).stdout], [''], 'told once');
  assert.notEqual((await runCli(['hook'], { cwd: repo, env, input: prompt(repo, SESSION.replace('0f', '1f')) })).stdout, '', 'every session is told');
  assert.equal((await runCli(['hook'], { cwd: repo, env, input: eventPayload('SessionStart', repo) })).stdout, '');
});

test('below the threshold, or with no saved reading, the prompt hook prints nothing', async (t) => {
  const { repo, env, cache } = scene(t);
  assert.equal((await runCli(['hook'], { cwd: repo, env, input: prompt(repo) })).stdout, '');
  await runCli(['statusline'], { cwd: repo, env, input: withLimits(repo, 60) });
  assert.equal((await runCli(['hook'], { cwd: repo, env, input: prompt(repo) })).stdout, '');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cache, 'limits.json'), 'utf8')) as object).sort(), ['at', 'fiveHour', 'sevenDay', 'v']);
});
