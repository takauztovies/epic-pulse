import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsFor } from '../src/paths.js';
import { refKey } from '../src/ref.js';
import { appendRegistryLine } from '../src/registry.js';
import type { BindVia } from '../src/schemas/common.js';
import { RegistryLineSchema, type RegistryLine } from '../src/schemas/registry.js';
import { advanceTime, creditsFor, EMPTY_TIME, IDLE_CAP_MS } from '../src/time.js';
import { readTime, updateTime } from '../src/time-store.js';
import { tempDir } from './repo-helpers.js';
import { demo } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const A = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
const [four, five] = [refKey(demo(4)), refKey(demo(5))];

type Bind = readonly [number, BindVia?];

interface Extras {
  readonly binds?: readonly Bind[];
  readonly unbinds?: readonly number[];
}

function line(ts: number, ev: RegistryLine['ev'] = 'tool', extras: Extras = {}): RegistryLine {
  const { binds = [], unbinds = [] } = extras;
  return RegistryLineSchema.parse({ v: 1, ts, ev, binds: binds.map(([n, via]) => ({ ref: demo(n), via: via ?? 'gh' })), unbinds: unbinds.map(demo) });
}
const on = (ts: number, ...binds: readonly Bind[]) => line(ts, 'tool', { binds });

const ms = (lines: readonly RegistryLine[], key: string) => creditsFor(lines, 0).get(key)?.ms ?? 0;

test('time between a session\'s calls goes to the issue it is working on', () => {
  const lines = [line(T0, 'start'), on(T0 + MIN, [4]), line(T0 + 2 * MIN), line(T0 + 4 * MIN)];
  assert.equal(ms(lines, four), 3 * MIN);
});

test('a gap longer than the idle cap counts for nothing, and the next one counts again', () => {
  const lines = [on(T0, [4]), line(T0 + IDLE_CAP_MS + 1), line(T0 + IDLE_CAP_MS + 1 + MIN)];
  assert.equal(ms(lines, four), MIN);
  assert.equal(ms([on(T0, [4]), line(T0 + IDLE_CAP_MS)], four), IDLE_CAP_MS, 'exactly the cap still counts');
});

test('the session is credited to the issue it touched last, so one minute is never counted twice', () => {
  const lines = [on(T0, [4]), on(T0 + MIN, [5]), line(T0 + 3 * MIN)];
  assert.deepEqual([ms(lines, four), ms(lines, five)], [MIN, 2 * MIN]);
  const both = [on(T0, [4], [5]), line(T0 + 2 * MIN)];
  assert.deepEqual([ms(both, four), ms(both, five)], [MIN, MIN], 'a call that touched two splits the time evenly');
});

test('an unbind, the end of the session and a lapsed binding stop the credit', () => {
  assert.equal(ms([on(T0, [4]), line(T0 + MIN, 'tool', { unbinds: [4] }), line(T0 + 2 * MIN)], four), MIN);
  assert.equal(ms([on(T0, [4]), line(T0 + MIN, 'end'), line(T0 + 2 * MIN, 'start'), line(T0 + 3 * MIN)], four), MIN);
  const calls = Array.from({ length: 84 }, (_, i) => line(T0 + (i + 1) * 5 * MIN));
  assert.equal(ms([on(T0, [4]), ...calls], four), 6 * 60 * MIN + 5 * MIN, 'live at exactly six hours (as the registry has it), lapsed after');
  assert.equal(ms([on(T0, [4, 'pin']), ...calls], four), 85 * 5 * MIN - 5 * MIN, 'a pin does not lapse');
});

test('counting again, or counting more later, never counts a minute twice', () => {
  const first = [on(T0, [4]), line(T0 + MIN), line(T0 + 2 * MIN)];
  const once = advanceTime(EMPTY_TIME, new Map([[A, first]]));
  assert.equal(once.refs[four]?.ms, 2 * MIN);
  assert.deepEqual(advanceTime(once, new Map([[A, first]])), once);
  const more = advanceTime(once, new Map([[A, [...first, line(T0 + 3 * MIN), line(T0 + 5 * MIN)]]]));
  assert.equal(more.refs[four]?.ms, 5 * MIN);
  assert.equal(more.sessions[A], T0 + 5 * MIN);
});

test('two sessions add up, and the latest activity names its session', () => {
  const total = advanceTime(EMPTY_TIME, new Map([
    [A, [on(T0, [4]), line(T0 + MIN)]],
    [B, [on(T0 + 10 * MIN, [4]), line(T0 + 12 * MIN)]],
  ]));
  assert.deepEqual([total.refs[four]?.ms, total.refs[four]?.lastSession, total.refs[four]?.lastTs], [3 * MIN, B, T0 + 12 * MIN]);
});

test('the refresher saves running totals that outlive the session files', async (t) => {
  const paths = pathsFor(tempDir(t));
  for (const l of [on(T0, [4]), line(T0 + 2 * MIN)]) assert.ok((await appendRegistryLine(paths, A, l)).ok);
  assert.equal((await updateTime(paths)).refs[four]?.ms, 2 * MIN);
  assert.equal((await readTime(paths)).refs[four]?.ms, 2 * MIN);
  assert.equal((await updateTime(paths)).refs[four]?.ms, 2 * MIN, 'a second refresh adds nothing');
});

test('a missing or corrupt time file reads as no time at all', async (t) => {
  assert.deepEqual(await readTime(pathsFor(tempDir(t))), EMPTY_TIME);
});
