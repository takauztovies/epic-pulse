import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardFailed, parseProject } from '@epic-pulse/core';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { modelOf } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, SESSION_A } from './registry-helpers.js';

// A board the token can not read degrades to derived status, which is still
// "ok": the notice says what is missing and how to grant it, above the epics.
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;
const HINT = 'board: token lacks read:project — `gh auth refresh -s read:project`';

test('a board refused for want of read:project shows one notice above the epics, and in the status bar tooltip', async (t) => {
  const now = Date.now();
  const board = boardFailed(undefined, PROJECT, { failure: { code: 'forbidden', detail: null }, now });
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: { ...demoSnapshot(now - 1000), board } }, now);
  const model = await modelOf([repo], now);
  assert.equal(model.state, 'ok');
  const roots = treeOf(model);
  assert.deepEqual(roots.map((node) => [node.kind, node.label]).slice(0, 2), [['notice', HINT], ['epic', '#1 ██░░░░░░░░ 20% Demo epic: sample onboarding flow']]);
  assert.match(statusBarOf(model).tooltip, /token lacks read:project/);
});

test('a board that was read, or none at all, shows no board notice', async (t) => {
  const now = Date.now();
  const failed = boardFailed(undefined, PROJECT, { failure: { code: 'network', detail: null }, now });
  for (const snapshot of [demoSnapshot(now - 1000), { ...demoSnapshot(now - 1000), board: failed }]) {
    const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot }, now);
    assert.ok(treeOf(await modelOf([repo], now)).every((node) => node.kind !== 'notice'));
  }
});
