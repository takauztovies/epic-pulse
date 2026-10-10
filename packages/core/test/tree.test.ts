import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhaseB } from '../src/queries.js';
import { epicsToWatch, EPIC_TTL_MS, needsFetch, SUB_EPIC_TTL_MS } from '../src/refresh-plan.js';
import { applyEpics, pruneSnapshot } from '../src/refresh-apply.js';
import { refKey } from '../src/ref.js';
import type { Child, EpicEntry, Snapshot } from '../src/schemas/snapshot.js';
import type { JsonChild } from '../src/schemas/json-v1.js';
import { emptySnapshot } from '../src/snapshot.js';
import { descendantEpics, MAX_TREE_DEPTH, MAX_TREE_NODES, subEpicKeys, subEpicRefs } from '../src/tree.js';
import { buildView } from '../src/view.js';
import { loadFixture } from './helpers.js';
import { demo } from './snapshot-helpers.js';

// A real tree from GitHub (recorded from the demo repository): program epic #43,
// whose child #44 is a sub-epic holding sub-epic #45 (leaf #48) and the closed
// #47, and a plain task #46. Each epic was recorded with its own Phase B answer.
const T0 = Date.parse('2026-10-10T12:00:00.000Z');

function nested(now = T0): Snapshot {
  const answers = [43, 44, 45].map((n) => {
    const parsed = parsePhaseB(loadFixture(`phase-b-nested-${n}`));
    assert.ok(parsed.ok);
    return [demo(n), parsed.value.epics.get(n) ?? null] as const;
  });
  return applyEpics(emptySnapshot(now), answers, now);
}

const view = (snapshot: Snapshot, now = T0) => buildView({ snapshot: { status: 'ok', snapshot }, sessions: [], pins: [{ ref: demo(43), addedAt: 0 }], now }).epics[0]!;
const shape = (children: readonly JsonChild[]): unknown => children.map((c) => [c.key, c.status, shape(c.children)]);
const counts = (c: { readonly counts: Record<string, number> | null }) => Object.fromEntries(Object.entries(c.counts ?? {}).filter(([, n]) => n > 0));

test('the recorded program epic comes back as the whole tree, however deep', () => {
  const epic = view(nested());
  assert.deepEqual(shape(epic.children), [
    ['#44', 'in_progress', [['#45', 'in_progress', [['#48', 'in_progress', []]]], ['#47', 'done', []]]],
    ['#46', 'todo', []],
  ]);
  const [a] = epic.children;
  assert.deepEqual([a?.subCount, a?.percent, counts(a!)], [2, 50, { in_progress: 1, done: 1 }]);
  assert.deepEqual([a?.children[0]?.subCount, a?.children[0]?.percent], [1, 0]);
});

test('an epic counts the leaves of its whole tree, not its direct children', () => {
  const epic = view(nested());
  assert.deepEqual([counts(epic), epic.percent, epic.children.length], [{ todo: 1, in_progress: 1, done: 1 }, 33, 2]);
  assert.equal(epic.truncated, false);
});

test('a sub-epic not fetched yet counts as one item until its own entry arrives', () => {
  const snapshot = nested();
  const onlyTop = Object.fromEntries(Object.entries(snapshot.epics).filter(([key]) => key === refKey(demo(43))));
  const epic = view({ ...snapshot, epics: onlyTop });
  assert.deepEqual(shape(epic.children), [['#44', 'todo', []], ['#46', 'todo', []]]);
  assert.deepEqual([epic.children[0]?.subCount, epic.children[0]?.counts, counts(epic)], [2, null, { todo: 2 }]);
});

// GitHub says a closed item is closed; a dropped sub-epic is work nobody will do,
// so what is under it must not count against the epic.
test('a dropped sub-epic counts as one dropped item and its children do not count', () => {
  const snapshot = nested();
  const top = snapshot.epics[refKey(demo(43))]!;
  const dropped: EpicEntry = { ...top, children: top.children.map((c) => (c.number === 44 ? { ...c, status: 'dropped' as const } : c)) };
  const epic = view({ ...snapshot, epics: { ...snapshot.epics, [refKey(demo(43))]: dropped } });
  assert.deepEqual([counts(epic), epic.percent], [{ todo: 1, dropped: 1 }, 0]);
  assert.deepEqual(epic.children[0]?.children, []);
});

test('a hierarchy that loops back on itself stops where it repeats', () => {
  const snapshot = nested();
  const deepest = snapshot.epics[refKey(demo(45))]!;
  const again = snapshot.epics[refKey(demo(43))]!.children.find((c) => c.number === 44)!;
  const looped: EpicEntry = { ...deepest, children: [...deepest.children, again] };
  const epic = view({ ...snapshot, epics: { ...snapshot.epics, [refKey(demo(45))]: looped } });
  const loop = epic.children[0]?.children[0]?.children.find((c) => c.key === '#44');
  assert.deepEqual([loop?.children, loop?.counts], [[], null], 'shown once more as a plain item, never followed again');
  assert.deepEqual(descendantEpics({ ...snapshot, epics: { ...snapshot.epics, [refKey(demo(45))]: looped } }, [demo(43)]).map(refKey), [refKey(demo(44)), refKey(demo(45))]);
});

// A chain of entries built from the recorded leaf, to run past the caps.
function child(number: number, subCount?: number): Child {
  return { number, title: `item ${number}`, url: `https://github.com/takauztovies/epic-pulse/issues/${number}`, status: 'todo', ...(subCount ? { subCount } : {}) };
}
const entry = (number: number, children: readonly Child[]): EpicEntry => ({ ref: demo(number), title: `epic ${number}`, url: child(number).url ?? '', kind: 'subissues', children, truncated: false, fetchedAt: T0, error: null });
const snapshotOf = (entries: readonly EpicEntry[]): Snapshot => ({ ...emptySnapshot(T0), epics: Object.fromEntries(entries.map((e) => [refKey(e.ref), e])) });
const depthOf = (children: readonly JsonChild[]): number => (children.length === 0 ? 0 : 1 + Math.max(...children.map((c) => depthOf(c.children))));
const deepestBranch = (children: readonly JsonChild[]): string | null => {
  const branch = children.find((c) => c.children.length > 0);
  return branch ? (deepestBranch(branch.children) ?? branch.key) : null;
};
const sizeOf = (children: readonly JsonChild[]): number => children.reduce((sum, c) => sum + 1 + sizeOf(c.children), 0);

// The refresh fetches MAX_TREE_DEPTH levels of sub-epics below the top epic, and
// the view shows every one of them with its items, and nothing it did not fetch.
test('a chain longer than the depth limit is followed down to it, the same in the refresh and the view', () => {
  const chain = Array.from({ length: MAX_TREE_DEPTH + 6 }, (_, i) => entry(43 + i, [child(44 + i, i === MAX_TREE_DEPTH + 5 ? 0 : 1)]));
  const fetched = descendantEpics(snapshotOf(chain), [demo(43)]);
  assert.equal(fetched.length, MAX_TREE_DEPTH);
  const epic = view(snapshotOf(chain));
  assert.equal(depthOf(epic.children), MAX_TREE_DEPTH + 1, 'every fetched sub-epic, then its items');
  assert.equal(deepestBranch(epic.children), `#${fetched.at(-1)?.number}`, 'the deepest sub-epic shown is the deepest one fetched');
});

test('a very wide tree stops expanding at the node limit and still finishes quickly', () => {
  const mids = Array.from({ length: 100 }, (_, i) => entry(1000 + i, Array.from({ length: 100 }, (_, j) => child(5000 + i * 100 + j))));
  const top = entry(43, mids.map((m) => child(m.ref.number, 100)));
  const started = performance.now();
  const epic = view(snapshotOf([top, ...mids]));
  assert.ok(sizeOf(epic.children) < MAX_TREE_NODES + 300, `${sizeOf(epic.children)} nodes`);
  assert.ok(sizeOf(epic.children) > 100, 'it did expand');
  assert.ok(performance.now() - started < 2000, `${Math.round(performance.now() - started)} ms`);
});

test('the refresh watches every sub-epic below what it watches, and a child with children names its own epic', () => {
  const snapshot = nested();
  assert.deepEqual(subEpicRefs(snapshot.epics[refKey(demo(43))]!).map(refKey), [refKey(demo(44))]);
  assert.deepEqual(descendantEpics(snapshot, [demo(43)]).map(refKey), [refKey(demo(44)), refKey(demo(45))]);
  const resolved: Snapshot = { ...snapshot, issues: { [refKey(demo(43))]: { epic: demo(43), resolvedAt: T0 } } };
  assert.deepEqual(epicsToWatch(resolved, [demo(43)], []).map(refKey), [refKey(demo(43)), refKey(demo(44)), refKey(demo(45))]);
  assert.deepEqual([...subEpicKeys(snapshot)].sort(), [refKey(demo(44)), refKey(demo(45))]);
});

// A tree of many sub-epics at the top epic's pace would spend the hourly budget in minutes.
test('a sub-epic is refreshed less often than the epic above it', () => {
  const snapshot = nested(T0);
  const all = [demo(43), demo(44), demo(45)];
  assert.deepEqual(needsFetch(snapshot, all, T0 + EPIC_TTL_MS).map(refKey), [refKey(demo(43))]);
  assert.deepEqual(needsFetch(snapshot, all, T0 + SUB_EPIC_TTL_MS).map(refKey).sort(), all.map(refKey).sort());
  assert.ok(SUB_EPIC_TTL_MS > EPIC_TTL_MS);
});

test('pruning keeps the sub-epics of an epic it keeps, and drops them with it', () => {
  const resolved: Snapshot = { ...nested(), issues: { [refKey(demo(43))]: { epic: demo(43), resolvedAt: T0 } } };
  assert.deepEqual(Object.keys(pruneSnapshot(resolved, [demo(43)], T0).epics).sort(), [43, 44, 45].map((n) => refKey(demo(n))));
  const later = T0 + 7 * 60 * 60 * 1000;
  assert.deepEqual(Object.keys(pruneSnapshot(resolved, [], later).epics), [], 'nothing keeps #43, so nothing keeps what is below it');
});
