import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etaLabel } from '../src/eta.js';
import { refKey } from '../src/ref.js';
import { JsonV1Schema, type JsonV1 } from '../src/schemas/json-v1.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { buildView } from '../src/view.js';
import { pacedSnapshot } from './eta-helpers.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function viewOf(snapshot: Snapshot, pins = [1]): JsonV1 {
  return buildView({ snapshot: { status: 'ok', snapshot }, sessions: [], pins: pins.map((n) => ({ ref: demo(n), addedAt: 0 })), now: NOW });
}

const etaOf = (snapshot: Snapshot) => viewOf(snapshot).epics[0]?.eta;

test("the ETA is the items still open at the last 14 days' pace, in whole days and never sooner", () => {
  // Three closed inside the window (a fourth, 20 days ago, is outside it), five
  // open, two dropped. Five open at three per 14 days is 23.3 days; a day is
  // whole, so 24.
  const snapshot = pacedSnapshot(NOW, { done: [DAY, 5 * DAY, 10 * DAY, 20 * DAY], todo: 3, in_progress: 1, in_review: 1, dropped: 2 });
  assert.equal(etaOf(snapshot), '2026-11-01');
});

test('fewer than two items done in the window is no pace, so no ETA', () => {
  const open = (done: readonly (number | undefined)[]) => etaOf(pacedSnapshot(NOW, { done, todo: 4 }));
  assert.equal(open([]), null, 'nothing done');
  assert.equal(open([DAY]), null, 'one done is an accident, not a pace');
  assert.equal(open([DAY, 15 * DAY, 30 * DAY]), null, 'the others are older than the window');
  assert.equal(open([undefined, undefined, DAY]), null, 'a close with no recorded date shows no pace');
  assert.equal(open([DAY, 2 * DAY]), '2026-11-05', 'two is enough: four open at two per 14 days is 28 days');
});

test('the window is the last 14 days, both ends in, and a close after now is no pace', () => {
  const closed = (...done: number[]) => etaOf(pacedSnapshot(NOW, { done, todo: 1 }));
  assert.equal(closed(DAY, 14 * DAY), '2026-10-15', 'closed exactly 14 days ago still counts');
  assert.equal(closed(DAY, 14 * DAY + 1), null, 'a millisecond older does not');
  assert.equal(closed(DAY, -1), null, 'closed after now does not');
});

// The refresher records no close date for a dropped item (resolve.ts), so this one
// is given a date: it is the status, not the date, that makes a close a delivery.
test('a dropped item is no delivery, whatever date it carries', () => {
  const snapshot = pacedSnapshot(NOW, { done: [DAY], todo: 3, dropped: 2 });
  const key = refKey(demo(1));
  const entry = snapshot.epics[key]!;
  const dated = entry.children.map((child) => (child.status === 'dropped' ? { ...child, closedAt: NOW - DAY } : child));
  assert.equal(etaOf({ ...snapshot, epics: { ...snapshot.epics, [key]: { ...entry, children: dated } } }), null);
});

test('an epic with nothing left to do has no ETA', () => {
  assert.equal(etaOf(pacedSnapshot(NOW, { done: [DAY, 2 * DAY, 3 * DAY], dropped: 2 })), null);
});

test('the pace is that of the whole tree: items below a sub-epic count, done or open', () => {
  // One closed here and one below #4; one open here and two below. Three open
  // at two per 14 days is 21 days.
  const snapshot = pacedSnapshot(NOW, { done: [DAY], todo: 1 }, { done: [2 * DAY], todo: 1, in_progress: 1 });
  assert.equal(etaOf(snapshot), '2026-10-29');
});

test('the recorded demo epics have no pace: their closed items carry no close date', () => {
  const view = viewOf(demoSnapshot(NOW), [1, 8]);
  assert.deepEqual(view.epics.map((epic) => [epic.number, epic.eta]).sort(), [[1, null], [8, null]]);
});

// The day comes from the UTC date, so it is the same on every machine; a local
// date would move by one in a zone far enough from UTC, and only there.
test('the ETA is a day in UTC, whatever zone the machine is in', (t) => {
  const before = process.env['TZ'];
  t.after(() => {
    if (before === undefined) delete process.env['TZ'];
    else process.env['TZ'] = before;
  });
  const snapshot = pacedSnapshot(NOW, { done: [DAY, 2 * DAY], todo: 4 });
  const inZone = (zone: string) => {
    process.env['TZ'] = zone;
    return etaOf(snapshot);
  };
  assert.deepEqual(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'].map(inZone), ['2026-11-05', '2026-11-05', '2026-11-05']);
});

test('the JSON view carries the ETA as a date, or null, and nothing else', () => {
  const view = viewOf(pacedSnapshot(NOW, { done: [DAY, 2 * DAY], todo: 4 }));
  assert.equal(JsonV1Schema.parse(view).epics[0]?.eta, '2026-11-05');
  assert.equal(JsonV1Schema.parse(viewOf(demoSnapshot(NOW))).epics[0]?.eta, null);
  const accepts = (eta: string) => JsonV1Schema.safeParse({ ...view, epics: [{ ...view.epics[0], eta }] }).success;
  assert.deepEqual([accepts('2026-11-05'), accepts('2026-11-05T12:00:00.000Z'), accepts('soon'), accepts('2026-02-30')], [true, false, false, false]);
});

test('an ETA reads as day and month, the way the status line and the hover show it', () => {
  assert.deepEqual(['2026-11-05', '2027-01-09', '2026-12-31'].map(etaLabel), ['05.11.', '09.01.', '31.12.']);
});
