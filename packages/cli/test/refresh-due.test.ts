import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, RegistryLineSchema, type SessionState } from '@epic-pulse/core';
import { refreshDue } from '../src/refresh-spawn.js';
import { demo, demoSnapshot } from './fixtures.js';
import { SESSION } from './helpers.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function bound(numbers: readonly number[], ts = NOW): SessionState {
  const binds = numbers.map((n) => ({ ref: demo(n), via: 'gh' as const }));
  return foldSession(SESSION, [RegistryLineSchema.parse({ v: 1, ts, ev: 'tool', binds })])!;
}

test('nothing is due while every resolution and epic is inside its cache', () => {
  assert.equal(refreshDue({ snapshot: { status: 'ok', snapshot: demoSnapshot(NOW) }, session: bound([4]), pins: [], now: NOW + MINUTE }), false);
});

test('an epic past its two-minute cache, an unresolved issue or a pin is due', () => {
  const snapshot = { status: 'ok', snapshot: demoSnapshot(NOW) } as const;
  assert.equal(refreshDue({ snapshot, session: bound([4]), pins: [], now: NOW + 2 * MINUTE }), true);
  assert.equal(refreshDue({ snapshot, session: bound([6]), pins: [], now: NOW + MINUTE }), true);
  assert.equal(refreshDue({ snapshot, session: bound([]), pins: [{ ref: demo(6), addedAt: NOW }], now: NOW + MINUTE }), true);
});

test('a missing or corrupt snapshot makes every bound issue due', () => {
  for (const snapshot of [{ status: 'missing' }, { status: 'corrupt' }] as const) {
    assert.equal(refreshDue({ snapshot, session: bound([4]), pins: [], now: NOW }), true, snapshot.status);
  }
});

test('with nothing bound or pinned, or no session the hook wrote for, nothing is due', () => {
  const missing = { status: 'missing' } as const;
  assert.equal(refreshDue({ snapshot: missing, session: bound([]), pins: [], now: NOW }), false);
  assert.equal(refreshDue({ snapshot: missing, session: undefined, pins: [{ ref: demo(6), addedAt: NOW }], now: NOW }), false);
});
