import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { emptySnapshot, STALE_AFTER_MS, type ErrorCode } from '@epic-pulse/core';
import { buildModel, type Model } from '../src/model.js';
import { barText } from '../src/labels.js';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { modelOf, surface } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, SESSION_A, tempDir } from './registry-helpers.js';

// Every state, from real registry and snapshot files read through core's
// buildView. Signed-out needs a real refresh and is in signed-out.test.ts.

test('a bound session shows its epic as "20% · 1/5" with the pinned epic after it, and no notice', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], pins: [demo(8)], snapshot: demoSnapshot(now - 1000) }, now);
  const model = await modelOf([repo], now);
  const roots = treeOf(model);
  assert.equal(model.state, 'ok');
  assert.deepEqual(roots.map((node) => [node.kind, node.label, node.description]), [
    ['epic', '#1 ██░░░░░░░░ 20% Demo epic: sample onboarding flow', '20% · 1/5'],
    ['epic', '#8 █████░░░░░ 50% Demo checklist epic: docs site', '50% · 2/4'],
  ]);
  const bar = statusBarOf(model);
  assert.deepEqual([bar.visible, bar.text, bar.command], [true, '$(pulse) #1 20% · 1/5 +1', 'epicPulse.epics.focus']);
});

test('an epic opens on GitHub and splits into status groups whose issues count their sessions', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const [epic] = treeOf(await modelOf([repo], now));
  assert.ok(epic?.kind === 'epic');
  assert.deepEqual(epic.command, { command: 'epicPulse.openIssue', title: 'Open on GitHub', arguments: [epic.url] });
  assert.equal(epic.url, 'https://github.com/takauztovies/epic-pulse/issues/1');
  const groups = epic.children.map((group) => [group.label, group.expanded, group.description, group.children.map((issue) => [issue.label.split(' ')[0], issue.description])]);
  assert.deepEqual(groups, [
    ['Todo', false, '1', [['#7', '']]],
    ['In progress', true, '2', [['#4', '1 session'], ['#6', '']]],
    ['In review', true, '1', [['#5', '']]],
    ['Done', true, '1', [['#2', '']]],
    ['Dropped', false, '1', [['#3', '']]],
  ]);
  const four = epic.children[1]?.children[0];
  assert.deepEqual(four?.command?.arguments, ['https://github.com/takauztovies/epic-pulse/issues/4']);
});

test('stale data stays on screen, marked on the epic, in the status bar and in a notice above it', async (t) => {
  const now = Date.now();
  const old = demoSnapshot(now - STALE_AFTER_MS - 60_000);
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: old }, now);
  const model = await modelOf([repo], now);
  assert.deepEqual(surface(model), ['stale', 'notice', 'Stale', 'updated 11 min ago', '$(pulse) #1 20% · 1/5 $(warning)']);
  assert.equal(treeOf(model)[1]?.description, '20% · 1/5 · stale');
});

test('none: the hook has written here, but no live session has an issue bound', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [] }], snapshot: demoSnapshot(now - 1000) }, now);
  assert.deepEqual(surface(await modelOf([repo], now)), ['none', 'notice', 'No epic', '', '$(pulse) No epic']);
});

test('hook inactive: a registry the hook never wrote a session to, or no registry at all', async (t) => {
  const now = Date.now();
  const snapshotOnly = await makeRegistry(t, { snapshot: demoSnapshot(now - 1000) }, now);
  const missing = { dir: join(tempDir(t), 'epic-pulse'), folder: tempDir(t), label: 'missing' };
  for (const repo of [snapshotOnly, missing]) {
    const expected = ['hook-inactive', 'notice', 'Hook inactive', '', '$(debug-disconnect) Hook inactive'];
    assert.deepEqual(surface(await modelOf([repo], now)), expected, repo.label);
  }
});

test('loading: a bound issue that no refresh has resolved yet', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(6)] }] }, now);
  assert.deepEqual(surface(await modelOf([repo], now)), ['loading', 'notice', 'Loading…', '', '$(sync~spin) Loading…']);
});

async function failingModel(t: TestContext, error: ErrorCode): Promise<Model> {
  const now = Date.now();
  const snapshot = { ...emptySnapshot(now), error, detail: 'ECONNRESET' };
  return modelOf([await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(6)] }], snapshot }, now)], now);
}

test('an error shows its code and only its code, never the stored detail', async (t) => {
  const model = await failingModel(t, 'network');
  assert.deepEqual(surface(model), ['error', 'notice', 'Refresh failed', 'network', '$(error) Refresh failed: network']);
  assert.match(statusBarOf(model).tooltip, /Code: `network`/);
  const everything = JSON.stringify([treeOf(model), statusBarOf(model)]);
  assert.equal(everything.includes('ECONNRESET'), false);
});

test('unsupported: a host without sub-issues', async (t) => {
  const model = await failingModel(t, 'unsupported');
  assert.deepEqual(surface(model), ['unsupported', 'notice', 'Unsupported host', 'unsupported', '$(circle-slash) Unsupported host']);
});

test('with no repository in the workspace the status bar stays hidden and the tree says why', () => {
  const model = buildModel({ results: [], now: Date.now() });
  assert.deepEqual(surface(model), ['none', 'notice', 'No epic', 'No git repository in this workspace', '$(pulse) No epic']);
  assert.equal(statusBarOf(model).visible, false);
});

test('the epic bar fills in tenths, rounding down, so it is never full before the epic is done', () => {
  assert.deepEqual([0, 9, 10, 19, 50, 99, 100].map(barText), [
    '░░░░░░░░░░', '░░░░░░░░░░', '█░░░░░░░░░', '█░░░░░░░░░', '█████░░░░░', '█████████░', '██████████',
  ]);
});
