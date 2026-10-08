import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEpics } from '../src/refresh-apply.js';
import { parsePhaseB } from '../src/queries.js';
import { refKey } from '../src/ref.js';
import { emptySnapshot } from '../src/snapshot.js';
import { SUMMARY_MAX, summaryOf } from '../src/summary.js';
import { buildView } from '../src/view.js';
import { loadFixture } from './helpers.js';
import { demo } from './snapshot-helpers.js';

// phase-b-details is a real recording of the demo epics with the creation and
// closing dates, assignee logins and bodies the hover shows.
const T0 = Date.parse('2026-10-08T12:00:00.000Z');

function recorded() {
  const parsed = parsePhaseB(loadFixture('phase-b-details'));
  assert.ok(parsed.ok);
  const snapshot = applyEpics(emptySnapshot(T0), [1, 8].map((n) => [demo(n), parsed.value.epics.get(n) ?? null] as const), T0);
  return snapshot;
}

test('the recorded epics keep their opening lines, their age, and who has what', () => {
  const [one, eight] = [recorded().epics[refKey(demo(1))]!, recorded().epics[refKey(demo(8))]!];
  assert.equal(one.summary, 'Public demo epic used by epic-pulse fixtures and live tests. Children cover every derived status.');
  assert.equal(one.createdAt, Date.parse('2026-09-30T13:13:05Z'));
  assert.equal(eight.summary?.startsWith('Checkbox-only epic (no sub-issues). Pick a static sit'), true);
  const six = one.children.find((child) => child.number === 6)!;
  assert.deepEqual(six.assignees, ['takauztovies']);
  const two = one.children.find((child) => child.number === 2)!;
  assert.deepEqual([two.status, two.closedAt, two.assignees], ['done', Date.parse('2026-09-30T13:13:28Z'), undefined]);
  assert.equal(one.children.find((child) => child.number === 3)?.closedAt, undefined, 'a dropped issue has no done date');
});

test('the view says how old an epic is and how much was finished this week, against its own clock', () => {
  const snapshot = { status: 'ok', snapshot: recorded() } as const;
  const at = (now: number) => buildView({ snapshot, sessions: [], pins: [{ ref: demo(1), addedAt: 0 }], now }).epics[0]!;
  const week = at(Date.parse('2026-10-05T00:00:00Z'));
  assert.deepEqual([week.createdAt, week.doneLast7Days], ['2026-09-30T13:13:05.000Z', 1]);
  assert.equal(at(Date.parse('2026-10-08T12:00:00Z')).doneLast7Days, 0, 'eight days on, it is no longer this week');
  assert.deepEqual([week.assignees, week.openPullRequests], [['takauztovies'], 0]);
  assert.match(week.summary ?? '', /^Public demo epic/);
});

test('an epic recorded before these fields existed still reads, with nothing to say', () => {
  const entry = recorded().epics[refKey(demo(1))]!;
  const old = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'summary' && key !== 'createdAt')) as typeof entry;
  const view = buildView({ snapshot: { status: 'ok', snapshot: { ...recorded(), epics: { [refKey(demo(1))]: old } } }, sessions: [], pins: [{ ref: demo(1), addedAt: 0 }], now: T0 });
  assert.deepEqual([view.epics[0]?.summary, view.epics[0]?.createdAt], [null, null]);
});

test('a summary is the readable opening of a description, never markup, links or code', () => {
  assert.equal(summaryOf(''), undefined);
  assert.equal(summaryOf('<!-- note -->\n\n```sh\nrm -rf /\n```\n'), undefined);
  assert.equal(summaryOf('# Goal\n\nShip the **new** [import wizard](https://x.invalid/a?b=c) for ![logo](a.png) <b>everyone</b>.\n- [ ] first\n- [x] second'), 'Goal Ship the new import wizard for everyone. first second');
  const long = `${'word '.repeat(100)}end`;
  const cut = summaryOf(long)!;
  assert.ok(cut.length <= SUMMARY_MAX + 1 && cut.endsWith('…') && !cut.includes('wor…'), cut);
});
