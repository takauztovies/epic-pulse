import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, type SessionState } from '../src/registry.js';
import { renderStatusLine } from '../src/render.js';
import type { JsonV1 } from '../src/schemas/json-v1.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { STALE_AFTER_MS } from '../src/status.js';
import { buildView } from '../src/view.js';
import { pacedSnapshot, zoneFor } from './eta-helpers.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ID = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const ESC = String.fromCharCode(27);
const strip = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

// The session bound to the demo sub-issue #4, whose epic is #1, and the pinned #8.
function viewOf(snapshot: Snapshot): JsonV1 {
  const line = RegistryLineSchema.parse({ v: 1, ts: NOW, ev: 'tool', binds: [{ ref: demo(4), via: 'gh' }] });
  const session: SessionState = foldSession(ID, [line])!;
  return buildView({ snapshot: { status: 'ok', snapshot }, sessions: [session], pins: [{ ref: demo(8), addedAt: NOW }], now: NOW, scope: { session } });
}

const withEta = (view: JsonV1, eta: string | null): JsonV1 => ({ ...view, epics: view.epics.map((epic) => ({ ...epic, eta })) });

test('the ETA ends the epic\'s own line, before the count of the other epics', (t) => {
  zoneFor(t)('Europe/Berlin');
  const view = withEta(viewOf(demoSnapshot(NOW)), '2026-10-29T12:00:00.000Z');
  assert.equal(renderStatusLine(view, { width: 120 }), '#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 · ETA 29.10. (+1)');
});

test('the ETA is shown only when the line still fits, and gives way before anything else does', (t) => {
  zoneFor(t)('Europe/Berlin');
  const plain = viewOf(demoSnapshot(NOW));
  const timed = withEta(plain, '2026-10-29T12:00:00.000Z');
  const full = renderStatusLine(timed, { width: 120 });
  assert.equal(full.length, 55);
  for (let width = 1; width <= 120; width += 1) {
    const expected: string = full.length <= width ? full : renderStatusLine(plain, { width });
    assert.equal(renderStatusLine(timed, { width }), expected, `width ${width}`);
  }
});

test('the ETA is plain text after a painted bar, and colour still adds no width', (t) => {
  zoneFor(t)('Europe/Berlin');
  const timed = withEta(viewOf(demoSnapshot(NOW)), '2026-10-29T12:00:00.000Z');
  const colored = renderStatusLine(timed, { width: 120, color: true });
  assert.ok(colored.endsWith(' 20% 1/5 · rev 1 · wip 2 · ETA 29.10. (+1)'), colored);
  assert.equal(strip(colored), renderStatusLine(timed, { width: 120 }));
});

test('the ETA comes after the stale marker and the loading count, the order the line already had', (t) => {
  zoneFor(t)('Europe/Berlin');
  const binds = [demo(4), demo(6)].map((ref) => ({ ref, via: 'gh' as const }));
  const session = foldSession(ID, [RegistryLineSchema.parse({ v: 1, ts: NOW, ev: 'tool', binds })])!;
  const input = { snapshot: { status: 'ok', snapshot: demoSnapshot(NOW) }, sessions: [session], pins: [], scope: { session } } as const;
  const stale = withEta(buildView({ ...input, now: NOW + STALE_AFTER_MS + 1 }), '2026-10-29T12:00:00.000Z');
  assert.equal(renderStatusLine(stale, { width: 120 }), '#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 · stale · 1 loading · ETA 29.10.');
});

test('an epic with no pace has the line it always had', () => {
  assert.equal(renderStatusLine(withEta(viewOf(demoSnapshot(NOW)), null), { width: 120 }), '#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)');
});

test('from the snapshot to the line: two done in the last 14 days and three open show the ETA', (t) => {
  zoneFor(t)('Europe/Berlin');
  const view = viewOf(pacedSnapshot(NOW, { done: [DAY, 2 * DAY], todo: 2, in_progress: 1 }));
  assert.equal(renderStatusLine(view, { width: 120 }), '#1 ▓▓▓▓░░░░░░ 40% 2/5 · wip 1 · ETA 29.10. (+1)');
});

test('an ETA in another year than the view was made in says which year', (t) => {
  zoneFor(t)('Europe/Berlin');
  const view = withEta(viewOf(demoSnapshot(NOW)), '2027-01-09T12:00:00.000Z');
  assert.equal(renderStatusLine(view, { width: 120 }), '#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 · ETA 09.01.2027 (+1)');
});
