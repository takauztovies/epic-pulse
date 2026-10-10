import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refKey } from '../src/ref.js';
import {
  backingOff, BUDGET_WINDOW_MS, EPIC_TTL_MS, epicRefsOf, epicsToWatch, gatherRefs, groupByRepo, needsFetch, needsResolution,
  phaseBBatchSize, phaseBCost, pinnedRefs, probeTargets, RESOLUTION_TTL_MS, rollUsage,
} from '../src/refresh-plan.js';
import { foldSession } from '../src/registry.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import { demo, demoSnapshot, subEpicSnapshot } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const session = (id: string, lines: readonly unknown[]) => foldSession(id, lines.map((l) => RegistryLineSchema.parse(l)))!;

test('the refresher gathers live, unexpired bindings and the pins, once each', () => {
  const live = session('0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b', [{ v: 1, ts: T0, ev: 'tool', binds: [{ ref: demo(4), via: 'gh' }, { ref: demo(5), via: 'branch' }] }]);
  const ended = session('1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d', [{ v: 1, ts: T0, ev: 'tool', binds: [{ ref: demo(6), via: 'gh' }] }, { v: 1, ts: T0 + 1, ev: 'end' }]);
  const pins = [{ ref: demo(8), addedAt: T0 }, { ref: demo(4), addedAt: T0 }];
  assert.deepEqual(gatherRefs([live, ended], pins, T0 + 10).map(refKey), [demo(4), demo(5), demo(8)].map(refKey));
});

test('refs are grouped per repository in first-seen order', () => {
  const other = { ...demo(2), owner: 'other' };
  const groups = groupByRepo([demo(4), other, demo(5)]);
  assert.deepEqual(groups.map((g) => [g.repo.owner, g.refs.map((r) => r.number)]), [['takauztovies', [4, 5]], ['other', [2]]]);
});

test('Phase A re-asks after 30 minutes; Phase B after 2 minutes, oldest first', () => {
  const snapshot = demoSnapshot(T0);
  assert.deepEqual(needsResolution(snapshot, [demo(4), demo(6)], T0 + 1000).map((r) => r.number), [6]);
  assert.deepEqual(needsResolution(snapshot, [demo(4)], T0 + RESOLUTION_TTL_MS).map((r) => r.number), [4]);
  assert.deepEqual(epicRefsOf(snapshot, [demo(4), demo(1), demo(8), demo(6)]).map((r) => r.number), [1, 8]);
  const older = { ...snapshot, epics: { ...snapshot.epics, [refKey(demo(8))]: { ...snapshot.epics[refKey(demo(8))]!, fetchedAt: T0 - 5000 } } };
  assert.deepEqual(needsFetch(older, [demo(1), demo(8)], T0 + EPIC_TTL_MS - 1).map((r) => r.number), [8]);
  assert.deepEqual(needsFetch(older, [demo(1), demo(8), demo(3)], T0 + EPIC_TTL_MS).map((r) => r.number), [3, 8, 1]);
});

test('the cost model matches GitHub: 5 points per epic (five nested connections), never below 1', () => {
  assert.deepEqual([0, 1, 2, 10].map(phaseBCost), [1, 5, 10, 50]);
  assert.equal(phaseBBatchSize({ windowStart: T0, points: 0 }), 10);
  assert.equal(phaseBBatchSize({ windowStart: T0, points: 294 }), 1);
  assert.equal(phaseBBatchSize({ windowStart: T0, points: 298 }), 0);
});

test('the hourly window resets after an hour, or when it starts in the future', () => {
  const usage = { windowStart: T0, points: 120 };
  assert.equal(rollUsage(usage, T0 + BUDGET_WINDOW_MS - 1), usage);
  assert.deepEqual(rollUsage(usage, T0 + BUDGET_WINDOW_MS), { windowStart: T0 + BUDGET_WINDOW_MS, points: 0 });
  assert.deepEqual(rollUsage(usage, T0 - 1), { windowStart: T0 - 1, points: 0 });
});

test('below 1000 remaining points the refresher backs off until GitHub resets', () => {
  assert.equal(backingOff(null, T0), false);
  assert.equal(backingOff({ remaining: 999, resetAt: T0 + 1 }, T0), true);
  assert.equal(backingOff({ remaining: 999, resetAt: T0 }, T0), false);
  assert.equal(backingOff({ remaining: 1000, resetAt: T0 + 1 }, T0), false);
});

const numbers = (refs: readonly { readonly number: number }[]) => refs.map((ref) => ref.number);

test('the pinned issues are the sessions\' pins, which never lapse, and the repository\'s pins, once each', () => {
  const lines = [{ v: 1, ts: T0, ev: 'tool', binds: [{ ref: demo(4), via: 'pin' }, { ref: demo(5), via: 'gh' }] }];
  const pinning = session('0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b', lines);
  const pins = [{ ref: demo(8), addedAt: T0 }, { ref: demo(4), addedAt: T0 }];
  assert.deepEqual(numbers(pinnedRefs([pinning], pins, T0 + 10)), [4, 8]);
  assert.deepEqual(numbers(pinnedRefs([pinning], [], T0 + 7 * 3_600_000)), [4]);
  assert.deepEqual(pinnedRefs([], [], T0), []);
});

// An issue with a parent resolves to the parent, and a pin names the issue
// itself, so the refresher has to ask whether it is an epic: once, and again
// only when its resolution is asked again.
test('a pinned issue with a parent is asked about as an epic of its own, until it has been found not to be one', () => {
  const snapshot = demoSnapshot(T0);
  const pinned = [demo(4), demo(1), demo(8), demo(6)];
  assert.deepEqual(numbers(probeTargets(snapshot, pinned)), [4]);
  const flagged = (isEpic: boolean) => ({ ...snapshot, issues: { ...snapshot.issues, [refKey(demo(4))]: { ...snapshot.issues[refKey(demo(4))]!, isEpic } } });
  assert.deepEqual(probeTargets(flagged(false), pinned), []);
  assert.deepEqual(numbers(probeTargets(flagged(true), pinned)), [4]);
  const refused = { ...snapshot, issues: { ...snapshot.issues, [refKey(demo(4))]: { epic: null, resolvedAt: T0, error: 'forbidden' as const } } };
  assert.deepEqual(probeTargets(refused, pinned), []);
  assert.deepEqual(probeTargets(snapshot, [demo(4), demo(4)]).length, 1);
});

test('the epics to watch are those the refs resolved to, then the pinned issues that may be epics themselves, once each', () => {
  const snapshot = subEpicSnapshot(T0);
  assert.deepEqual(numbers(epicsToWatch(snapshot, [demo(4), demo(8)], [demo(4)])), [1, 8, 4]);
  assert.deepEqual(numbers(epicsToWatch(snapshot, [demo(4)], [])), [1]);
  assert.deepEqual(numbers(epicsToWatch(snapshot, [demo(1)], [demo(4), demo(1)])), [1, 4]);
});
