import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePhaseA, parsePhaseB } from '../src/queries.js';
import { refKey } from '../src/ref.js';
import { applyEpics, applyResolutions, chargeRate, markEpicErrors, pruneSnapshot } from '../src/refresh-apply.js';
import { RETAIN_MS } from '../src/refresh-plan.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { countStatuses, percentDone } from '../src/status.js';
import { loadFixture } from './helpers.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot, subEpicSnapshot } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const key = (n: number) => refKey(demo(n));

test('Phase A answers become resolutions: sub-issue to parent, epic to itself, missing to none', () => {
  const parsed = parsePhaseA(loadFixture('phase-a'));
  assert.ok(parsed.ok);
  const answers = [1, 4, 8, 9999].map((n) => [demo(n), parsed.value.issues.get(n) ?? null] as const);
  const snapshot = applyResolutions(emptySnapshot(T0), answers, T0);
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.issues).map(([k, r]) => [k, r.epic?.number ?? null])), {
    [key(1)]: 1, [key(4)]: 1, [key(8)]: 8, [key(9999)]: null,
  });
  assert.ok(Object.values(snapshot.issues).every((r) => r.resolvedAt === T0));
});

test('Phase B answers become epic entries with the demo counts', () => {
  const snapshot = demoSnapshot(T0);
  const epic = snapshot.epics[key(1)]!;
  assert.deepEqual([epic.kind, epic.fetchedAt, epic.error, epic.children.length], ['subissues', T0, null, 6]);
  assert.deepEqual(countStatuses(epic.children), { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 });
  assert.equal(percentDone(countStatuses(epic.children)), 20);
  const checklist = snapshot.epics[key(8)]!;
  assert.equal(checklist.kind, 'checklist');
  assert.deepEqual(countStatuses(checklist.children), { todo: 2, in_progress: 0, in_review: 0, done: 2, dropped: 1 });
});

test('an answer that is not an epic removes the entry and re-points its issues at none', () => {
  const missing = parsePhaseB(loadFixture('phase-b-missing'));
  const checklist = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(missing.ok && checklist.ok);
  const plain = { ...checklist.value.epics.get(8)!, body: 'Just an issue.' };
  const next = applyEpics(demoSnapshot(T0), [[demo(8), plain], [demo(9999), missing.value.epics.get(9999) ?? null]], T0 + 5);
  assert.equal(next.epics[key(8)], undefined);
  assert.deepEqual(next.issues[key(8)], { epic: null, resolvedAt: T0 + 5 });
  assert.equal(next.issues[key(4)]?.epic?.number, 1);
  assert.ok(next.epics[key(1)]);
});

test('a failed fetch keeps the data and marks the error; unknown epics are untouched', () => {
  const snapshot = demoSnapshot(T0);
  const marked = markEpicErrors(snapshot, [demo(1), demo(3)], 'unauthorized');
  assert.equal(marked.epics[key(1)]?.error, 'unauthorized');
  assert.deepEqual(marked.epics[key(1)]?.children, snapshot.epics[key(1)]?.children);
  assert.equal(marked.epics[key(8)]?.error, null);
  assert.equal(marked.epics[key(3)], undefined);
});

test('a response is charged its reported cost and updates the rate limit', () => {
  const charged = chargeRate({ ...emptySnapshot(T0), usage: { windowStart: T0, points: 10 } }, { cost: 3, remaining: 4887, resetAt: T0 + 60_000 });
  assert.deepEqual([charged.usage, charged.rateLimit], [{ windowStart: T0, points: 13 }, { remaining: 4887, resetAt: T0 + 60_000 }]);
});

test('pruning keeps what is wanted or recent, and only epics a kept issue points at', () => {
  const snapshot = demoSnapshot(T0);
  assert.deepEqual(pruneSnapshot(snapshot, [], T0 + RETAIN_MS - 1), snapshot);
  const kept = pruneSnapshot(snapshot, [demo(4)], T0 + RETAIN_MS);
  assert.deepEqual(Object.keys(kept.issues), [key(4)]);
  assert.deepEqual(Object.keys(kept.epics), [key(1)]);
  assert.deepEqual(pruneSnapshot(snapshot, [], T0 + RETAIN_MS), { ...snapshot, issues: {}, epics: {} });
});

// The snapshot keeps at most 500 children an epic. Before, a longer checklist
// failed the whole snapshot write, and so every refresh after it.
test('a checklist epic longer than the snapshot keeps is stored cut at 500 and flagged truncated', async (t) => {
  const parsed = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(parsed.ok);
  const body = Array.from({ length: 600 }, (_, i) => `- [x] step ${i + 1}`).join('\n');
  const next = applyEpics(demoSnapshot(T0), [[demo(8), { ...parsed.value.epics.get(8)!, body }]], T0 + 5);
  const file = join(tempDir(t), 'snapshot.json');
  await writeSnapshot(file, next);
  const read = await readSnapshot(file);
  const epic = read.status === 'ok' ? read.snapshot.epics[key(8)] : undefined;
  assert.deepEqual([epic?.children.length, epic?.truncated, epic?.error, epic?.children.at(-1)?.title], [500, true, null, 'step 500']);
});

// Phase B was asked about #4, a sub-issue of epic #1, because it was pinned:
// not "what epic is it in" (Phase A answered, #1) but "is it an epic itself".
test('an answer about an issue that resolves to its parent says whether the issue is an epic itself, and leaves the parent as it was', () => {
  const sub = subEpicSnapshot(T0 + 5);
  assert.deepEqual([sub.epics[key(4)]?.children.length, sub.issues[key(4)]?.isEpic, sub.issues[key(4)]?.epic?.number], [6, true, 1]);
  assert.deepEqual(sub.issues[key(1)], { epic: demo(1), resolvedAt: T0 + 5 }, 'an issue that resolves to itself carries no flag');
  const checklist = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(checklist.ok);
  const plain = { ...checklist.value.epics.get(8)!, body: 'Just an issue.' };
  const none = applyEpics(demoSnapshot(T0), [[demo(4), plain]], T0 + 5);
  assert.deepEqual([none.epics[key(4)], none.issues[key(4)]?.isEpic, none.issues[key(4)]?.epic?.number, none.issues[key(4)]?.resolvedAt], [undefined, false, 1, T0]);
  assert.ok(none.epics[key(1)]);
});

test('asking Phase A again forgets what Phase B found, so a pinned issue is asked about again with its resolution', () => {
  const parsed = parsePhaseA(loadFixture('phase-a'));
  assert.ok(parsed.ok);
  const again = applyResolutions(subEpicSnapshot(T0), [[demo(4), parsed.value.issues.get(4) ?? null]], T0 + 1);
  assert.deepEqual(again.issues[key(4)], { epic: demo(1), resolvedAt: T0 + 1 });
});

test('the epic entry of a pinned issue that is one is kept beside its parent\'s, and goes with it when nothing keeps either', () => {
  const sub = subEpicSnapshot(T0);
  const kept = pruneSnapshot(sub, [demo(4)], T0 + 1);
  assert.deepEqual(Object.keys(kept.epics).sort(), [key(1), key(4), key(8)].sort());
  const onlyOlder = pruneSnapshot({ ...sub, issues: { [key(4)]: sub.issues[key(4)]! } }, [], T0 + RETAIN_MS - 1);
  assert.deepEqual(Object.keys(onlyOlder.epics).sort(), [key(1), key(4)].sort());
  assert.deepEqual(pruneSnapshot(sub, [], T0 + RETAIN_MS).epics, {});
});
