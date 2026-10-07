import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STALE_AFTER_MS } from '@epic-pulse/core';
import { buildModel } from '../src/model.js';
import { pollRepo } from '../src/poll.js';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { surface } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, noGhEnv, SESSION_A } from './registry-helpers.js';

// A real refresh, offline: no VS Code sign-in, no GH_TOKEN, and no `gh` on the
// PATH, so core really finds no token and records `no_token`.

test('signed out: with no VS Code sign-in and no token anywhere, the tree and the status bar offer the sign-in', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(6)] }] }, now);
  const result = await pollRepo(repo, { now, env: noGhEnv(t), grant: {} });
  assert.deepEqual([result.refresh, result.token], [{ status: 'done', requests: 0, points: 0, error: 'no_token' }, 'none']);
  const model = buildModel({ results: [result], now });
  assert.deepEqual(surface(model), ['signed-out', 'notice', 'Sign in to GitHub', 'no_token', '$(account) Sign in to GitHub']);
  assert.equal(treeOf(model)[0]?.command?.command, 'epicPulse.signIn');
  assert.equal(statusBarOf(model).command, 'epicPulse.signIn');
  assert.match(statusBarOf(model).tooltip, /Sign in to GitHub/);
});

test('the same failure with a VS Code sign-in in use is an error with its code, not a sign-in prompt', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(6)] }] }, now);
  const result = await pollRepo(repo, { now, env: noGhEnv(t), grant: {} });
  const model = buildModel({ results: [{ ...result, token: 'session' }], now });
  assert.deepEqual(surface(model), ['error', 'notice', 'Refresh failed', 'no_token', '$(error) Refresh failed: no_token']);
  assert.equal(statusBarOf(model).command, 'epicPulse.epics.focus');
});

test('signed out with data from before keeps the epic on screen, and its click signs in', async (t) => {
  const now = Date.now();
  const old = demoSnapshot(now - STALE_AFTER_MS - 60_000);
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: old }, now);
  const result = await pollRepo(repo, { now, env: noGhEnv(t), grant: {} });
  assert.deepEqual([result.view.snapshot.state, result.view.snapshot.error], ['stale', 'no_token']);
  const model = buildModel({ results: [result], now });
  assert.deepEqual(surface(model), ['signed-out', 'notice', 'Sign in to GitHub', 'no_token', '$(pulse) #1 20% · 1/5 $(warning)']);
  // Stale by age only: a refresh without a token leaves the epic's own error alone.
  assert.equal(treeOf(model)[1]?.description, '20% · 1/5 · Session: 0f8e7c1a · stale');
  assert.equal(statusBarOf(model).command, 'epicPulse.signIn');
});
