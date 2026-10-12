import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etaLabel } from '../src/eta.js';
import { refKey } from '../src/ref.js';
import { JsonV1Schema, type JsonV1 } from '../src/schemas/json-v1.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { buildView } from '../src/view.js';
import { pacedSnapshot, zoneFor } from './eta-helpers.js';
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
  assert.equal(etaOf(snapshot), '2026-11-01T12:00:00.000Z');
});

test('fewer than two items done in the window is no pace, so no ETA', () => {
  const open = (done: readonly (number | undefined)[]) => etaOf(pacedSnapshot(NOW, { done, todo: 4 }));
  assert.equal(open([]), null, 'nothing done');
  assert.equal(open([DAY]), null, 'one done is an accident, not a pace');
  assert.equal(open([DAY, 15 * DAY, 30 * DAY]), null, 'the others are older than the window');
  assert.equal(open([undefined, undefined, DAY]), null, 'a close with no recorded date shows no pace');
  assert.equal(open([DAY, 2 * DAY]), '2026-11-05T12:00:00.000Z', 'two is enough: four open at two per 14 days is 28 days');
});

test('the window is the last 14 days, both ends in, and a close after now is no pace', () => {
  const closed = (...done: number[]) => etaOf(pacedSnapshot(NOW, { done, todo: 1 }));
  assert.equal(closed(DAY, 14 * DAY), '2026-10-15T12:00:00.000Z', 'closed exactly 14 days ago still counts');
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
  assert.equal(etaOf(snapshot), '2026-10-29T12:00:00.000Z');
});

test('the recorded demo epics have no pace: their closed items carry no close date', () => {
  const view = viewOf(demoSnapshot(NOW), [1, 8]);
  assert.deepEqual(view.epics.map((epic) => [epic.number, epic.eta]).sort(), [[1, null], [8, null]]);
});

// The JSON holds an instant, not a day, so it is the same on every machine; only
// the label turns it into a day, on the calendar of the machine showing it.
test('the ETA is the same instant whatever zone the machine is in', (t) => {
  const zone = zoneFor(t);
  const snapshot = pacedSnapshot(NOW, { done: [DAY, 2 * DAY], todo: 4 });
  const inZone = (name: string) => {
    zone(name);
    return etaOf(snapshot);
  };
  const instant = '2026-11-05T12:00:00.000Z';
  assert.deepEqual(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'].map(inZone), [instant, instant, instant]);
});

test('the JSON view carries the ETA as an ISO datetime, or null, and nothing else', () => {
  const view = viewOf(pacedSnapshot(NOW, { done: [DAY, 2 * DAY], todo: 4 }));
  assert.equal(JsonV1Schema.parse(view).epics[0]?.eta, '2026-11-05T12:00:00.000Z');
  assert.equal(JsonV1Schema.parse(viewOf(demoSnapshot(NOW))).epics[0]?.eta, null);
  const accepts = (eta: string) => JsonV1Schema.safeParse({ ...view, epics: [{ ...view.epics[0], eta }] }).success;
  assert.deepEqual([accepts('2026-11-05T12:00:00.000Z'), accepts('2026-11-05'), accepts('soon'), accepts('2026-02-30T12:00:00.000Z')], [true, false, false, false]);
});

test('an ETA reads as day and month, with the year only when it is not this year', (t) => {
  zoneFor(t)('Europe/Berlin');
  const labels = ['2026-11-05T12:00:00.000Z', '2026-12-31T12:00:00.000Z', '2027-01-09T12:00:00.000Z'].map((eta) => etaLabel(eta, NOW));
  assert.deepEqual(labels, ['05.11.', '31.12.', '09.01.2027']);
});

// 23:30 UTC on 28 October is already 00:30 on the 29th in Berlin, and still the
// 28th in New York: the day shown is the one on the viewer's own calendar.
test('the day is the local one, also when UTC is already on another', (t) => {
  const zone = zoneFor(t);
  const inZone = (name: string) => {
    zone(name);
    return etaLabel('2026-10-28T23:30:00.000Z', NOW);
  };
  assert.deepEqual(['Europe/Berlin', 'America/New_York'].map(inZone), ['29.10.', '28.10.']);
});

test('the year is the local one too, for the ETA and for now', (t) => {
  zoneFor(t)('Europe/Berlin');
  // New Year's Eve 23:30 UTC is New Year's Day in Berlin: another year than now's.
  assert.equal(etaLabel('2026-12-31T23:30:00.000Z', NOW), '01.01.2027');
  // And the same moment as now is already in 2027 there, so 2027 is this year.
  assert.equal(etaLabel('2027-01-05T12:00:00.000Z', Date.parse('2026-12-31T23:30:00.000Z')), '05.01.');
});
