import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { parseBoardPage } from '../src/board-query.js';
import { boardEntry, boardFailed } from '../src/board.js';
import { parsePhaseB } from '../src/queries.js';
import { makeRef, refKey } from '../src/ref.js';
import { applyEpics } from '../src/refresh-apply.js';
import type { ProjectConfig } from '../src/schemas/board.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { emptySnapshot } from '../src/snapshot.js';
import { countStatuses, percentDone } from '../src/status.js';
import { buildView } from '../src/view.js';
import { loadFixture } from './helpers.js';
import { demo } from './snapshot-helpers.js';

// The recorded demo epic #1 (phase-b-board: #2 done, #3 not planned, #4 closed,
// #5 with a ready PR, #6 assigned, #7 untouched) read against the recorded demo
// board (#4 Done, #5 Todo, #6 In Progress), as the refresher applies them.
const T0 = Date.parse('2026-10-12T12:00:00Z');
const DEMO = parseProject({ owner: 'takauztovies', number: 3 })!;

function withBoard(project: ProjectConfig, board = 'board-demo'): Snapshot {
  const page = parseBoardPage(loadFixture(board));
  assert.ok(page.ok);
  return { ...emptySnapshot(T0), board: boardEntry(project, [page.value], T0) };
}

function epic(snapshot: Snapshot) {
  const parsed = parsePhaseB(loadFixture('phase-b-board'));
  assert.ok(parsed.ok);
  return applyEpics(snapshot, [[demo(1), parsed.value.epics.get(1) ?? null]], T0).epics[refKey(demo(1))]!;
}

const rows = (snapshot: Snapshot) => epic(snapshot).children.map((child) => [child.number, child.status, child.statusSource]);

test('without a board every status is derived, and no source is recorded', () => {
  assert.deepEqual(rows(emptySnapshot(T0)), [
    [2, 'done', undefined], [3, 'dropped', undefined], [4, 'done', undefined], [5, 'in_review', undefined], [6, 'in_progress', undefined], [7, 'todo', undefined],
  ]);
});

test('an open issue on the board takes its mapped option; one not on it keeps its derived status', () => {
  assert.deepEqual(rows(withBoard(DEMO)), [
    [2, 'done', 'derived'], [3, 'dropped', 'derived'], [4, 'done', 'derived'], [5, 'todo', 'board'], [6, 'in_progress', 'board'], [7, 'todo', 'derived'],
  ]);
});

test('a closed issue keeps its derived status: a board can not reopen it', () => {
  const reopening = parseProject({ owner: 'takauztovies', number: 3, statusMap: { Done: 'in_progress' } })!;
  const four = epic(withBoard(reopening)).children.find((child) => child.number === 4);
  assert.deepEqual([four?.status, four?.statusSource], ['done', 'derived']);
});

test('an option that maps to nothing keeps the derived status', () => {
  const page = parseBoardPage(loadFixture('board-demo'));
  assert.ok(page.ok);
  const renamed = { ...page.value, items: page.value.items.map((item) => (item.key.endsWith('#5') ? { ...item, option: 'Icebox' } : item)) };
  const snapshot = { ...emptySnapshot(T0), board: boardEntry(DEMO, [renamed], T0) };
  const five = epic(snapshot).children.find((child) => child.number === 5);
  assert.deepEqual([five?.status, five?.statusSource], ['in_review', 'derived']);
  assert.deepEqual(snapshot.board.unmapped, ['Icebox']);
});

test('a board `dropped` on an open issue leaves the denominator, like a not-planned close', () => {
  const dropping = parseProject({ owner: 'takauztovies', number: 3, statusMap: { Todo: 'dropped' } })!;
  const before = countStatuses(epic(withBoard(DEMO)).children);
  const after = countStatuses(epic(withBoard(dropping)).children);
  assert.deepEqual([before.dropped, after.dropped], [1, 2]);
  // 2 done of 5 counted, then of 4: #5 left the denominator.
  assert.deepEqual([percentDone(before), percentDone(after)], [40, 50]);
});

test('a board `done` on an open issue counts as done', () => {
  const finishing = parseProject({ owner: 'takauztovies', number: 3, statusMap: { 'In Progress': 'done' } })!;
  const six = epic(withBoard(finishing)).children.find((child) => child.number === 6);
  assert.deepEqual([six?.status, six?.statusSource], ['done', 'board']);
});

test('a token without read:project degrades to derived status everywhere', () => {
  const scope = boardFailed(withBoard(DEMO).board, DEMO, { failure: { code: 'forbidden', detail: null }, now: T0 });
  const snapshot = { ...emptySnapshot(T0), board: scope };
  assert.deepEqual(rows(snapshot).map(([number, status]) => [number, status]), rows(emptySnapshot(T0)).map(([number, status]) => [number, status]));
  assert.ok(rows(snapshot).every(([, , source]) => source === 'derived'));
});

test('an epic on another host is not read against the github.com board', () => {
  const other = makeRef({ host: 'ghe.example.com', owner: 'takauztovies', repo: 'epic-pulse', number: 1 })!;
  const parsed = parsePhaseB(loadFixture('phase-b-board'));
  assert.ok(parsed.ok);
  const entry = applyEpics(withBoard(DEMO), [[other, parsed.value.epics.get(1) ?? null]], T0).epics[refKey(other)]!;
  assert.ok(entry.children.every((child) => child.statusSource === undefined));
});

test('epic-pulse json says how the board read went, and nothing without a board', () => {
  const view = (snapshot: Snapshot) => buildView({ snapshot: { status: 'ok', snapshot }, sessions: [], pins: [{ ref: demo(1), addedAt: 0 }], now: T0 }).snapshot;
  const scope = boardFailed(undefined, DEMO, { failure: { code: 'forbidden', detail: null }, now: T0 });
  assert.equal(view({ ...emptySnapshot(T0), board: scope }).boardError, 'scope');
  assert.equal(view(withBoard(DEMO)).boardError, null);
  assert.equal('boardError' in view(emptySnapshot(T0)), false);
});
