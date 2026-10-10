import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { emptySnapshot, refKey, STALE_AFTER_MS, type ErrorCode } from '@epic-pulse/core';
import { buildModel, type Model } from '../src/model.js';
import { activityLines, barText, detailLines, durationText, epicSessionsText, issueDetailLines } from '../src/labels.js';
import { statusBarOf } from '../src/status-model.js';
import { childrenOf, treeOf, type TreeNode } from '../src/tree-model.js';
import { modelOf, surface } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, nestedSnapshot, SESSION_A, tempDir } from './registry-helpers.js';

// Every state, from real registry and snapshot files read through core's
// buildView. Signed-out needs a real refresh and is in signed-out.test.ts.

test('a bound session shows its epic as "20% · 1/5" with the pinned epic after it, and no notice', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], pins: [demo(8)], snapshot: demoSnapshot(now - 1000) }, now);
  const model = await modelOf([repo], now);
  const roots = treeOf(model);
  assert.equal(model.state, 'ok');
  assert.deepEqual(roots.map((node) => [node.kind, node.label, node.description]), [
    ['epic', '#1 ██░░░░░░░░ 20% Demo epic: sample onboarding flow', '20% · 1/5 · Session: 0f8e7c1a'],
    ['epic', '#8 █████░░░░░ 50% Demo checklist epic: docs site', '50% · 2/4 · No live session'],
  ]);
  const bar = statusBarOf(model);
  assert.deepEqual([bar.visible, bar.text, bar.command], [true, '$(pulse) #1 20% · 1/5 +1', 'epicPulse.epics.focus']);
});

test('an epic opens on GitHub and splits into status groups whose issues count their sessions', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const [epic] = treeOf(await modelOf([repo], now));
  assert.ok(epic?.kind === 'epic');
  assert.deepEqual(epic.command, { command: 'epicPulse.openSession', title: 'Open Claude Code session', arguments: [[SESSION_A]] });
  assert.equal(epic.url, 'https://github.com/takauztovies/epic-pulse/issues/1');
  const groups = epic.children.map((group) => [group.label, group.expanded, group.description, group.children.map((issue) => [issue.label.split(' ')[0], issue.description, issue.iconColor])]);
  assert.deepEqual(groups, [
    ['Todo', false, '1', [['#7', '', undefined]]],
    ['In progress', true, '2', [['#4', '1 session', 'charts.green'], ['#6', '', undefined]]],
    ['In review', true, '1', [['#5', '', undefined]]],
    ['Done', true, '1', [['#2', '', undefined]]],
    ['Dropped', false, '1', [['#3', '', undefined]]],
  ]);
  const four = epic.children[1]?.children[0];
  assert.deepEqual(four?.command, { command: 'epicPulse.openSession', title: 'Open Claude Code session', arguments: [[SESSION_A]] });
  const six = epic.children[1]?.children[1];
  assert.deepEqual(six?.command?.arguments, ['https://github.com/takauztovies/epic-pulse/issues/6'], 'no live session: a click opens GitHub');
});

test('every epic lists all five status groups with their counts, even the empty ones', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { pins: [demo(8)], snapshot: demoSnapshot(now - 1000) }, now);
  const [checklist] = treeOf(await modelOf([repo], now));
  assert.ok(checklist?.kind === 'epic');
  assert.deepEqual(checklist.children.map((group) => [group.label, group.description, group.children.length]), [
    ['Todo', '2', 2], ['In progress', '0', 0], ['In review', '0', 0], ['Done', '2', 2], ['Dropped', '1', 1],
  ]);
});

test('stale data stays on screen, marked on the epic, in the status bar and in a notice above it', async (t) => {
  const now = Date.now();
  const old = demoSnapshot(now - STALE_AFTER_MS - 60_000);
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: old }, now);
  const model = await modelOf([repo], now);
  assert.deepEqual(surface(model), ['stale', 'notice', 'Stale', 'updated 11 min ago', '$(pulse) #1 20% · 1/5 $(warning)']);
  assert.equal(treeOf(model)[1]?.description, '20% · 1/5 · Session: 0f8e7c1a · stale');
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

test('the status bar and the epic icon turn green only once the first epic is entirely done and not stale', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const model = await modelOf([repo], now);
  assert.equal(statusBarOf(model).color, undefined, 'the demo epic is only 20% done');
  const [notYetDone] = treeOf(model);
  assert.equal(notYetDone?.kind === 'epic' ? notYetDone.iconColor : 'wrong kind', undefined);
  const done: Model = { ...model, epics: model.epics.map((epic) => ({ ...epic, percent: 100, stale: false })) };
  assert.equal(statusBarOf(done).color, 'charts.green');
  const [doneNode] = treeOf(done);
  assert.equal(doneNode?.kind === 'epic' ? doneNode.iconColor : 'wrong kind', 'charts.green');
  const staleDone: Model = { ...model, epics: done.epics.map((epic) => ({ ...epic, stale: true })) };
  assert.equal(statusBarOf(staleDone).color, undefined, 'stale is not the same claim as done');
});

test('the epic sessions line names which session, not only how many', () => {
  assert.equal(epicSessionsText({ sessionIds: [] }), 'No live session');
  assert.equal(epicSessionsText({ sessionIds: ['0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b'] }), 'Session: 0f8e7c1a');
  assert.equal(epicSessionsText({ sessionIds: ['0f8e7c1a-...', '1a2b3c4d-...'] }), 'Sessions: 0f8e7c1a, 1a2b3c4d');
});

test('session time reads as people say it, and a zero is never mistaken for a missing figure', () => {
  assert.deepEqual([0, 30, 60, 3599, 3600, 12_000, 90_000, 200_000].map(durationText), [
    'none yet', 'under 1 min', '1 min', '59 min', '1 h 0 min', '3 h 20 min', '1 d 1 h', '2 d 7 h',
  ]);
});

test('the hover says what sessions spent and when one was last on it', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const idle = { activeSeconds: 0, lastActivityAt: null, lastSessionId: null };
  assert.deepEqual(activityLines(idle, now), ['Session time: none yet']);
  const busy = { activeSeconds: 7500, lastActivityAt: '2026-10-08T11:48:00.000Z', lastSessionId: '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b' };
  assert.deepEqual(activityLines(busy, now), ['Session time: 2 h 5 min', 'Last active 12 min ago (session 0f8e7c1a)']);
});

test('the epic hover gives its summary, what is in flight, who has it, how old it is and whether it moves', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const epic = { summary: 'Ship the import wizard.', createdAt: '2026-09-26T12:00:00.000Z', doneLast7Days: 3, openPullRequests: 2, assignees: ['ana', 'bo'] };
  assert.deepEqual(detailLines(epic, now), [
    'Summary: Ship the import wizard.', 'Open pull requests: 2 · Assigned: @ana, @bo', 'Opened 12 days ago · 3 done in the last 7 days',
  ]);
  assert.deepEqual(detailLines({ ...epic, summary: null, createdAt: null, assignees: [], openPullRequests: 0, doneLast7Days: 0 }, now), [
    'Open pull requests: 0', '0 done in the last 7 days',
  ]);
  assert.deepEqual(issueDetailLines({ assignees: ['ana'], openPullRequests: 1 }), ['Assigned: @ana', 'Open pull requests: 1']);
  assert.deepEqual(issueDetailLines({ assignees: [], openPullRequests: 0 }), []);
});

test('the status bar tooltip is Markdown, so an epic summary from GitHub can not become a link or markup', async (t) => {
  const now = Date.now();
  const snapshot = demoSnapshot(now - 1000);
  const key = refKey(demo(1));
  const hostile = { ...snapshot, epics: { ...snapshot.epics, [key]: { ...snapshot.epics[key]!, summary: '[click](https://example.invalid) **bold** <img src=x>' } } };
  const model = await modelOf([await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: hostile }, now)], now);
  const line = statusBarOf(model).tooltip.split('\n').find((text) => text.startsWith('Summary\\:')) ?? '';
  assert.doesNotMatch(line.replace(/\\./g, ''), /[[\]()<>*_:.@]/);
  assert.equal(line.replace(/\\(.)/g, '$1').trimEnd(), 'Summary: [click](https://example.invalid) **bold** <img src=x>');
});

// Every row that has items under it opens onto its own status groups, however deep.
test('a sub-epic row opens onto its own status groups, down to the deepest leaf', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(48)] }], pins: [demo(43)], snapshot: nestedSnapshot(now - 1000) }, now);
  const [epic] = treeOf(await modelOf([repo], now));
  const items = (node: TreeNode | undefined): readonly TreeNode[] => childrenOf(node!).flatMap(childrenOf);
  const a = items(epic).find((n) => n.label.startsWith('#44'));
  const b = items(a).find((n) => n.label.startsWith('#45'));
  const leaf = items(b).find((n) => n.label.startsWith('#48'));
  assert.deepEqual([a?.description, a?.icon], ['50% · 1/2 · 1 session', 'type-hierarchy-sub']);
  assert.deepEqual([b?.description, leaf?.icon, leaf?.iconColor], ['0% · 0/1 · 1 session', 'issues', 'charts.green']);
  assert.deepEqual(childrenOf(leaf!), [], 'a leaf has nothing to open');
  assert.equal(new Set([epic, a, b, leaf].map((n) => n?.id)).size, 4, 'ids stay unique at every level');
});
