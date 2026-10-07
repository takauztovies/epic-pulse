import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refKey } from '../src/ref.js';
import { foldSession, type SessionState } from '../src/registry.js';
import type { BindVia, StateKind } from '../src/schemas/common.js';
import { JsonV1Schema, type JsonV1 } from '../src/schemas/json-v1.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import { emptySnapshot, type SnapshotRead } from '../src/snapshot.js';
import { STALE_AFTER_MS } from '../src/status.js';
import { DEFAULT_PROGRESS } from '../src/progress-config.js';
import { buildView, type ViewInput } from '../src/view.js';
import { demo, demoSnapshot, subEpicSnapshot } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const A = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
const fresh: SnapshotRead = { status: 'ok', snapshot: demoSnapshot(T0) };

function session(id: string, binds: readonly (readonly [number, BindVia, number?])[], ev: 'tool' | 'end' = 'tool'): SessionState {
  const lines = binds.map(([n, via, ts]) => RegistryLineSchema.parse({ v: 1, ts: ts ?? T0, ev: 'tool', binds: [{ ref: demo(n), via }] }));
  return foldSession(id, [...lines, RegistryLineSchema.parse({ v: 1, ts: T0, ev })])!;
}

function view(input: Partial<ViewInput> & Pick<ViewInput, 'sessions'>): JsonV1 {
  return JsonV1Schema.parse(buildView({ snapshot: fresh, pins: [], now: T0 + 1000, ...input }));
}

test('a session bound to a sub-issue sees its epic with the demo counts, then the pinned epic', () => {
  const own = session(A, [[4, 'gh']]);
  const result = view({ sessions: [own], pins: [{ ref: demo(8), addedAt: T0 }], scope: { session: own } });
  assert.deepEqual([result.snapshot.state, result.liveSessions, result.epics.map((e) => e.number)], ['ok', 1, [1, 8]]);
  const [epic, checklist] = result.epics;
  assert.equal(epic?.weightedPercent, 45);
  assert.deepEqual([epic?.percent, epic?.counts], [20, { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 }]);
  assert.deepEqual(epic?.children.map((c) => [c.number, c.sessionCount]), [[2, 0], [3, 0], [4, 1], [5, 0], [6, 0], [7, 0]]);
  assert.deepEqual([checklist?.kind, checklist?.counts.done, checklist?.counts.dropped, checklist?.percent], ['checklist', 2, 1, 50]);
  assert.equal(result.snapshot.fetchedAt, new Date(T0).toISOString());
});

test('without a scope the view covers every live session and counts them per child', () => {
  const sessions = [session(A, [[4, 'gh']]), session(B, [[4, 'branch'], [5, 'gh']]), session(B.replace('1', '9'), [[5, 'gh']], 'end')];
  const result = view({ sessions });
  assert.equal(result.liveSessions, 2);
  const epic = result.epics[0]!;
  const counts = new Map(epic.children.map((c) => [c.number, c.sessionCount] as const));
  assert.deepEqual([counts.get(4), counts.get(5), counts.get(6)], [2, 1, 0]);
  const ids = new Map(epic.children.map((c) => [c.number, c.sessionIds] as const));
  assert.deepEqual([ids.get(4), ids.get(5), ids.get(6)], [[A, B], [B], []]);
  // The epic's own answer is every child's sessions, deduplicated: B is on
  // two children but appears once.
  assert.deepEqual(epic.sessionIds, [A, B]);
});

test('the most recent binding comes first, and an expired one drops out', () => {
  const recent = session(A, [[8, 'gh', T0], [4, 'gh', T0 + 10]]);
  assert.deepEqual(view({ sessions: [recent], scope: { session: recent } }).epics.map((e) => e.number), [1, 8]);
  const expired = session(A, [[4, 'gh', T0 - 7 * 3_600_000]]);
  assert.deepEqual(view({ sessions: [expired], scope: { session: expired } }).snapshot.state, 'none');
});

function stateOf(read: SnapshotRead, bound: readonly number[], now = T0 + 1000): StateKind {
  const own = session(A, bound.map((n) => [n, 'gh'] as const));
  return view({ snapshot: read, sessions: [own], scope: { session: own }, now }).snapshot.state;
}

test('every state is explicit: hook-inactive, none, loading, error, unsupported, stale and ok', () => {
  const empty = emptySnapshot(T0);
  const noEpic = { ...empty, issues: { [refKey(demo(7))]: { epic: null, resolvedAt: T0 } } };
  assert.equal(view({ sessions: [], scope: { session: undefined } }).snapshot.state, 'hook-inactive');
  assert.equal(stateOf(fresh, []), 'none');
  assert.equal(stateOf({ status: 'ok', snapshot: noEpic }, [7]), 'none');
  assert.equal(stateOf({ status: 'ok', snapshot: empty }, [6]), 'loading');
  assert.equal(stateOf({ status: 'missing' }, [6]), 'loading');
  assert.equal(stateOf({ status: 'corrupt' }, [4]), 'loading');
  assert.equal(stateOf({ status: 'ok', snapshot: { ...empty, error: 'unauthorized' } }, [6]), 'error');
  assert.equal(stateOf({ status: 'ok', snapshot: { ...empty, error: 'unsupported' } }, [6]), 'unsupported');
  assert.equal(stateOf(fresh, [4], T0 + STALE_AFTER_MS + 1), 'stale');
  assert.equal(stateOf(fresh, [4]), 'ok');
});

test('an epic known only through a failed fetch is stale and carries the error', () => {
  const snapshot = demoSnapshot(T0);
  const key = refKey(demo(1));
  const failing: SnapshotRead = { status: 'ok', snapshot: { ...snapshot, error: 'network', epics: { [key]: { ...snapshot.epics[key]!, error: 'network' } } } };
  const own = session(A, [[4, 'gh']]);
  const result = view({ snapshot: failing, sessions: [own], scope: { session: own } });
  assert.deepEqual([result.snapshot.state, result.snapshot.error, result.epics[0]?.stale, result.epics[0]?.error], ['stale', 'network', true, 'network']);
});

// A resolution GitHub refused for good is cached for 30 minutes, so the run
// that recorded it may be long past and the snapshot's own error clear again.
test('an issue whose resolution was refused for good shows that code while nothing else is shown', () => {
  const refused = (code: 'forbidden' | 'unsupported'): SnapshotRead => ({
    status: 'ok', snapshot: { ...emptySnapshot(T0), issues: { [refKey(demo(6))]: { epic: null, resolvedAt: T0, error: code } } },
  });
  const own = session(A, [[6, 'gh']]);
  const seen = (read: SnapshotRead) => view({ snapshot: read, sessions: [own], scope: { session: own } }).snapshot;
  assert.deepEqual(seen(refused('forbidden')), { state: 'error', fetchedAt: new Date(T0).toISOString(), error: 'forbidden' });
  assert.deepEqual([seen(refused('unsupported')).state, seen(refused('unsupported')).error], ['unsupported', 'unsupported']);
});

// What the status line says as "1 loading": bindings that have not been
// answered yet, beside the epic that has.
test('bindings still waiting for an answer are counted beside the epic already shown', () => {
  const own = session(A, [[4, 'gh'], [6, 'gh']]);
  const result = view({ sessions: [own], scope: { session: own } });
  assert.deepEqual([result.snapshot.state, result.epics.map((e) => e.number), result.pending], ['ok', [1], 1]);
  const resolved = session(A, [[4, 'gh'], [8, 'gh']]);
  assert.equal(view({ sessions: [resolved], scope: { session: resolved } }).pending, 0);
  const several = session(A, [[4, 'gh'], [6, 'gh'], [7, 'gh']]);
  assert.equal(view({ sessions: [several], scope: { session: several } }).pending, 2);
});

// Resolved to an epic that has not been fetched yet is waiting too; one the
// last refresh failed on has the error to say, as stateOf does, and is not.
test('an epic not fetched yet is pending, and nothing is pending once the refresh failed', () => {
  const snapshot = demoSnapshot(T0);
  const unfetched: SnapshotRead = { status: 'ok', snapshot: { ...snapshot, epics: {} } };
  const own = session(A, [[4, 'gh']]);
  assert.deepEqual([view({ snapshot: unfetched, sessions: [own], scope: { session: own } }).pending, view({ snapshot: unfetched, sessions: [own], scope: { session: own } }).epics.length], [1, 0]);
  const failed: SnapshotRead = { status: 'ok', snapshot: { ...snapshot, epics: {}, error: 'network' } };
  assert.equal(view({ snapshot: failed, sessions: [own], scope: { session: own } }).pending, 0);
  assert.equal(view({ snapshot: { status: 'missing' }, sessions: [own], scope: { session: own } }).pending, 1);
});

// A pin names its issue. An issue with a parent resolves to that parent, which
// is right for work bound to it and wrong for a pin on a sub-epic: the pin shows
// the sub-epic itself, once the refresher has found it to be one.
test('a pinned issue that is itself an epic shows as that, for a session pin and a repository pin alike', () => {
  const read: SnapshotRead = { status: 'ok', snapshot: subEpicSnapshot(T0) };
  const sessionPin = session(A, [[4, 'pin']]);
  const bySession = view({ snapshot: read, sessions: [sessionPin], scope: { session: sessionPin } }).epics;
  assert.deepEqual(bySession.map((epic) => [epic.number, epic.children.length]), [[4, 6]]);
  const idle = session(A, []);
  const byRepository = view({ snapshot: read, sessions: [idle], pins: [{ ref: demo(4), addedAt: T0 }], scope: { session: idle } }).epics;
  assert.deepEqual(byRepository.map((epic) => epic.number), [4]);
  assert.deepEqual(view({ snapshot: read, sessions: [sessionPin] }).epics.map((epic) => epic.number), [4]);
});

test('work bound to that issue, and a pin on an issue that is no epic, still show the parent epic', () => {
  const bound = session(A, [[4, 'gh']]);
  const subEpic: SnapshotRead = { status: 'ok', snapshot: subEpicSnapshot(T0) };
  assert.deepEqual(view({ snapshot: subEpic, sessions: [bound], scope: { session: bound } }).epics.map((epic) => epic.number), [1]);
  const pinned = session(A, [[4, 'pin']]);
  assert.deepEqual(view({ snapshot: fresh, sessions: [pinned], scope: { session: pinned } }).epics.map((epic) => epic.number), [1]);
});

test('a sub-epic pin and work on its parent epic show the two epics, the work first', () => {
  const own = session(A, [[1, 'gh'], [4, 'pin']]);
  const read: SnapshotRead = { status: 'ok', snapshot: subEpicSnapshot(T0) };
  assert.deepEqual(view({ snapshot: read, sessions: [own], scope: { session: own } }).epics.map((epic) => epic.number), [1, 4]);
});

test('size labels weigh the percentages, and the item counts stay item counts', () => {
  const base = demoSnapshot(T0);
  const key = refKey(demo(1));
  const epic = base.epics[key]!;
  const sized = epic.children.map((c) => (c.number === 2 ? { ...c, labels: ['size/xl'] } : c.number === 7 ? { ...c, labels: ['size/xs'] } : c));
  const snapshot: SnapshotRead = { status: 'ok', snapshot: { ...base, epics: { ...base.epics, [key]: { ...epic, children: sized } } } };
  const own = session(A, [[4, 'gh']]);
  const result = view({ snapshot, sessions: [own], scope: { session: own } }).epics[0];
  assert.deepEqual(result?.counts, { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 });
  assert.equal(result?.percent, 44);
});

test('the repository progress config changes the percentages, and a child in the output carries only its documented fields', () => {
  const base = demoSnapshot(T0);
  const key = refKey(demo(1));
  const epic = base.epics[key]!;
  const sized = epic.children.map((c) => (c.number === 2 ? { ...c, labels: ['est:4'] } : c));
  const snapshot: SnapshotRead = { status: 'ok', snapshot: { ...base, epics: { ...base.epics, [key]: { ...epic, children: sized } } } };
  const own = session(A, [[4, 'gh']]);
  const progress = { ...DEFAULT_PROGRESS, sizes: { 'est:4': 4 }, unsized: 1, inProgress: 50, inReview: 50 };
  const result = buildView({ snapshot, sessions: [own], pins: [], now: T0 + 1000, scope: { session: own }, progress }).epics[0];
  assert.equal(result?.percent, 4 * 100 / (4 + 1 + 1 + 1 + 1) | 0);
  assert.deepEqual(Object.keys(result?.children[0] ?? {}).sort(), ['number', 'sessionCount', 'sessionIds', 'status', 'title', 'url']);
});
