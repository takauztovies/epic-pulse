import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, type SessionState } from '../src/registry.js';
import { renderStatusLine } from '../src/render.js';
import type { StateKind } from '../src/schemas/common.js';
import type { JsonV1 } from '../src/schemas/json-v1.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import { emptySnapshot } from '../src/snapshot.js';
import { STALE_AFTER_MS } from '../src/status.js';
import { buildView } from '../src/view.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const ID = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

function bound(...numbers: number[]): SessionState {
  return foldSession(ID, [RegistryLineSchema.parse({ v: 1, ts: T0, ev: 'tool', binds: numbers.map((n) => ({ ref: demo(n), via: 'gh' })) })])!;
}

function demoView(session: SessionState, now = T0 + 1000): JsonV1 {
  const pins = [{ ref: demo(8), addedAt: T0 }];
  return buildView({ snapshot: { status: 'ok', snapshot: demoSnapshot(T0) }, sessions: [session], pins, now, scope: { session } });
}

test('the demo epic renders as the documented line, with the pinned epic counted', () => {
  assert.equal(renderStatusLine(demoView(bound(4)), { width: 120 }), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)');
});

test('a binding still loading is counted after the epic, and goes before anything else is cut', () => {
  const loading = demoView(bound(4, 6));
  assert.equal(renderStatusLine(loading, { width: 120 }), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 · 1 loading (+1)');
  assert.equal(renderStatusLine(loading, { width: 50 }), '#1 20% 1/5 · rev 1 · wip 2 · 1 loading (+1)');
  assert.equal(renderStatusLine(loading, { width: 30 }), '#1 20% 1/5 · 1 loading (+1)');
  assert.equal(renderStatusLine(loading, { width: 14 }), '#1 20%');
  assert.equal(renderStatusLine(demoView(bound(4, 6, 7)), { width: 120 }), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 · 2 loading (+1)');
  const stale = demoView(bound(4, 6), T0 + STALE_AFTER_MS + 1);
  assert.equal(renderStatusLine(stale, { width: 120 }), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 · stale · 1 loading (+1)');
});

test('a checkbox epic shows checked over countable, dropped left out', () => {
  assert.equal(renderStatusLine(demoView(bound(8)), { width: 120 }), '#8 ▓▓▓▓▓░░░░░ 50% 2/4');
});

test('a stale epic says so, with the reason when a fetch failed', () => {
  const stale = demoView(bound(4), T0 + STALE_AFTER_MS + 1);
  assert.equal(renderStatusLine(stale, { width: 120 }), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 · stale (+1)');
  const failed: JsonV1 = { ...stale, epics: stale.epics.map((e) => ({ ...e, error: 'rate_limited' as const })) };
  assert.match(renderStatusLine(failed, { width: 120 }), / · stale \(rate_limited\) \(\+1\)$/);
  assert.match(renderStatusLine(stale, { width: 14 }), /^#1 20% · stale$/);
});

test('every other state has its own explicit text', () => {
  const base = demoView(bound(4));
  const as = (state: StateKind, error: JsonV1['snapshot']['error'] = null): string =>
    renderStatusLine({ ...base, snapshot: { ...base.snapshot, state, error }, epics: [] }, { width: 120 });
  const texts = [as('hook-inactive'), as('none'), as('loading'), as('error', 'unauthorized'), as('unsupported')];
  assert.deepEqual(texts, ['epic-pulse: hook inactive', 'epic-pulse: no epic', 'epic-pulse: loading…',
    'epic-pulse: error (unauthorized)', 'epic-pulse: unsupported host (no sub-issues)']);
  assert.equal(as('ok'), 'epic-pulse: no epic');
  const inactive = buildView({ snapshot: { status: 'ok', snapshot: emptySnapshot(T0) }, sessions: [], pins: [], now: T0, scope: { session: undefined } });
  assert.equal(renderStatusLine(inactive), 'epic-pulse: hook inactive');
});

test('narrow widths drop detail before they cut text, and never exceed the width', () => {
  const line = (width: number) => renderStatusLine(demoView(bound(4)), { width });
  assert.equal(line(42), '#1 ▓▓▓▓░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)');
  assert.equal(line(41), '#1 20% 1/5 · rev 1 · wip 2 (+1)');
  assert.equal(line(30), '#1 20% 1/5 (+1)');
  assert.equal(line(10), '#1 20%');
  assert.equal(line(5), '#1 2…');
  for (let width = 1; width <= 60; width += 1) assert.ok(line(width).length <= width, String(width));
});

test('an epic with more sub-issues than one page marks its fraction', () => {
  const view = demoView(bound(4));
  const truncated: JsonV1 = { ...view, epics: view.epics.map((e) => ({ ...e, truncated: true })) };
  assert.match(renderStatusLine(truncated, { width: 120 }), / 1\/5\+ /);
});
