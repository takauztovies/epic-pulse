import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptySnapshot, refKey } from '@epic-pulse/core';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { modelOf } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, SESSION_A, SESSION_B, tempDir } from './registry-helpers.js';

// Multi-root windows: every workspace repository's view folded into one.

test('a multi-root window shows each epic once, with every registry counting its own sessions', async (t) => {
  const now = Date.now();
  const snapshot = demoSnapshot(now - 1000);
  const first = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot }, now);
  const second = await makeRegistry(t, { sessions: [{ id: SESSION_B, binds: [demo(4)] }], pins: [demo(8)], snapshot }, now);
  const model = await modelOf([first, second], now);
  assert.deepEqual([model.state, model.liveSessions, model.repoCount], ['ok', 2, 2]);
  assert.deepEqual(model.epics.map((epic) => epic.number), [1, 8]);
  const counts = model.epics[0]?.children.map((child) => [child.number, child.sessionCount]);
  assert.deepEqual(counts, [[2, 0], [3, 0], [4, 2], [5, 0], [6, 0], [7, 0]]);
  assert.match(statusBarOf(model).tooltip, /^\*\*Epic Pulse\*\* · 2 live sessions · updated just now/);
});

test('the copy of an epic shown is the newest fetch among the registries', async (t) => {
  const now = Date.now();
  const older = demoSnapshot(now - 60_000);
  const key = refKey(demo(1));
  const renamed = { ...older, epics: { ...older.epics, [key]: { ...older.epics[key]!, title: 'Older title', fetchedAt: now - 60_000 } } };
  const stale = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: renamed }, now);
  const fresh = await makeRegistry(t, { sessions: [{ id: SESSION_B, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const model = await modelOf([stale, fresh], now);
  assert.deepEqual(model.epics.map((epic) => epic.title), ['Demo epic: sample onboarding flow']);
});

test('with nothing to show in any repository, the most telling state wins', async (t) => {
  const now = Date.now();
  const failing = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(6)] }], snapshot: { ...emptySnapshot(now), error: 'network' } }, now);
  const idle = await makeRegistry(t, { sessions: [{ id: SESSION_B, binds: [] }] }, now);
  const silent = { dir: join(tempDir(t), 'epic-pulse'), label: 'silent' };
  const states = [[silent, idle, failing], [silent, idle], [silent]].map(async (repos) => (await modelOf(repos, now)).state);
  assert.deepEqual(await Promise.all(states), ['error', 'none', 'hook-inactive']);
});

test('data in one repository wins over a failure in another, which keeps its code to itself', async (t) => {
  const now = Date.now();
  const working = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const failing = await makeRegistry(t, { sessions: [{ id: SESSION_B, binds: [demo(6)] }], snapshot: { ...emptySnapshot(now), error: 'network' } }, now);
  const model = await modelOf([failing, working], now);
  assert.deepEqual([model.state, model.error, treeOf(model)[0]?.kind], ['ok', null, 'epic']);
});

test('an issue title stays text in the Markdown tooltip: no link, no emphasis, no HTML', async (t) => {
  const now = Date.now();
  const snapshot = demoSnapshot(now - 1000);
  const key = refKey(demo(1));
  const title = '[click](https://example.invalid) **bold** <img src=x> www.example.invalid';
  const hostile = { ...snapshot, epics: { ...snapshot.epics, [key]: { ...snapshot.epics[key]!, title } } };
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: hostile }, now);
  const model = await modelOf([repo], now);
  const line = statusBarOf(model).tooltip.split('\n').find((text) => text.startsWith('**#1** '))?.slice(7).trimEnd() ?? '';
  assert.equal(line.replace(/\\(.)/g, '$1'), title, 'the escaped title still reads as the title');
  assert.doesNotMatch(line.replace(/\\./g, ''), /[[\]()<>*_:.@]/, 'no character Markdown gives a meaning is left bare');
  assert.equal(treeOf(model)[0]?.label, `██░░░░░░░░ 20% ${title}`, 'the tree label is plain text: the bar and percent, then the title as it is');
});
