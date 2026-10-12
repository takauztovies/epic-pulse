import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, type SessionState } from '../src/registry.js';
import { renderStatusLine } from '../src/render.js';
import type { JsonEpic, JsonV1 } from '../src/schemas/json-v1.js';
import { RegistryLineSchema } from '../src/schemas/registry.js';
import { buildView } from '../src/view.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

const T0 = 1_800_000_000_000;
const ID = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const ESC = String.fromCharCode(27);
const strip = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
// One run of bar cells in the colour (an SGR code) the status line paints it.
const run = (code: number, cells: string) => `${ESC}[${code}m${cells}${ESC}[0m`;

// The recorded demo epic #1 (one done, one in review, two in progress, one
// todo: 20%) for the session bound to its sub-issue #4, and the pinned #8.
function demoView(): JsonV1 {
  const line = RegistryLineSchema.parse({ v: 1, ts: T0, ev: 'tool', binds: [{ ref: demo(4), via: 'gh' }] });
  const session: SessionState = foldSession(ID, [line])!;
  const pins = [{ ref: demo(8), addedAt: T0 }];
  return buildView({ snapshot: { status: 'ok', snapshot: demoSnapshot(T0) }, sessions: [session], pins, now: T0 + 1000, scope: { session } });
}

test('the bar is painted by status: Done green, In review cyan, In progress yellow, the rest dim', () => {
  // Of the eight cells still open, one open item in four is in review, two in four in progress.
  const painted = `${run(32, '▓▓')}${run(36, '░░')}${run(33, '░░░░')}${run(2, '░░')}`;
  assert.equal(renderStatusLine(demoView(), { width: 120, color: true }), `#1 ${painted} 20% 1/5 · rev 1 · wip 2 (+1)`);
});

test('colour adds no width: without its escape codes the line is the plain line, at every width', () => {
  const view = demoView();
  for (let width = 1; width <= 120; width += 1) {
    const plain = renderStatusLine(view, { width });
    const colored = renderStatusLine(view, { width, color: true });
    assert.equal(strip(colored), plain, `width ${width}`);
    assert.equal(colored.includes(ESC), plain.includes('▓'), `only a line with a bar has colour, at width ${width}`);
  }
});

test('colour is off unless asked for', () => {
  const view = demoView();
  const plain = renderStatusLine(view, { width: 120 });
  assert.equal(renderStatusLine(view, { width: 120, color: false }), plain);
  assert.equal(plain.includes(ESC), false);
});

test('a state with no epic to show stays plain, colour or not', () => {
  const base = demoView();
  const none: JsonV1 = { ...base, snapshot: { ...base.snapshot, state: 'none' }, epics: [] };
  assert.equal(renderStatusLine(none, { color: true }), 'epic-pulse: no epic');
});

// The bar of the demo epic with some of its fields replaced, painted: the text
// between the key and the percent. No escape code contains a space.
function paintedBar(patch: Partial<JsonEpic>): string {
  const view = demoView();
  const epic = { ...view.epics[0]!, ...patch };
  return renderStatusLine({ ...view, epics: [epic] }, { width: 120, color: true }).split(' ')[1] ?? '';
}

const NONE = { todo: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };

test('Done fills the cells the percent fills; the cells left are shared out by the open items, rounded down', () => {
  assert.equal(paintedBar({ counts: { ...NONE, todo: 5 }, percent: 0 }), run(2, '░░░░░░░░░░'), 'nothing in flight is all dim');
  assert.equal(paintedBar({ counts: { ...NONE, done: 5 }, percent: 100 }), run(32, '▓▓▓▓▓▓▓▓▓▓'), 'finished is all green');
  assert.equal(
    paintedBar({ counts: { ...NONE, todo: 1, in_review: 1, in_progress: 1 }, percent: 0 }),
    `${run(36, '░░░')}${run(33, '░░░')}${run(2, '░░░░')}`,
    'a third of ten cells is three; the cell left over is not claimed by anyone',
  );
  assert.equal(
    paintedBar({ counts: { ...NONE, done: 1, todo: 6, in_progress: 3 }, percent: 50 }),
    `${run(32, '▓▓▓▓▓')}${run(33, '░')}${run(2, '░░░░')}`,
    'the green cells follow the percent (weighted by size), the others the items',
  );
});

test('an epic with nothing countable has a dim bar, not a missing one', () => {
  assert.equal(paintedBar({ counts: { ...NONE, dropped: 3 }, percent: 0 }), run(2, '░░░░░░░░░░'));
});
