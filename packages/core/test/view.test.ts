import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refKey } from '../src/ref.js';
import { foldSession, type SessionState } from '../src/registry.js';
import type { BindVia, StateKind } from '../src/schemas/common.js';
import { JsonV1Schema, type JsonV1 } from '../src/schemas/json-v1.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import { emptySnapshot, type SnapshotRead } from '../src/snapshot.js';
import { STALE_AFTER_MS } from '../src/status.js';
import { buildView, type ViewInput } from '../src/view.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

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
  assert.deepEqual([epic?.percent, epic?.counts], [20, { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 }]);
  assert.deepEqual(epic?.children.map((c) => [c.number, c.sessionCount]), [[2, 0], [3, 0], [4, 1], [5, 0], [6, 0], [7, 0]]);
  assert.deepEqual([checklist?.kind, checklist?.counts.done, checklist?.counts.dropped, checklist?.percent], ['checklist', 2, 1, 50]);
  assert.equal(result.snapshot.fetchedAt, new Date(T0).toISOString());
});

test('without a scope the view covers every live session and counts them per child', () => {
  const sessions = [session(A, [[4, 'gh']]), session(B, [[4, 'branch'], [5, 'gh']]), session(B.replace('1', '9'), [[5, 'gh']], 'end')];
  const result = view({ sessions });
  assert.equal(result.liveSessions, 2);
  const counts = new Map(result.epics[0]!.children.map((c) => [c.number, c.sessionCount] as const));
  assert.deepEqual([counts.get(4), counts.get(5), counts.get(6)], [2, 1, 0]);
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
