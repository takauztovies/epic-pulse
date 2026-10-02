import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldSession, RegistryLineSchema, type SessionState } from '@epic-pulse/core';
import type { RefreshAttempt } from '../src/refresh-attempt.js';
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

// A refresh that stops before it sends anything (no token, a spent hour)
// changes nothing that would make the next render's answer different.
test('after a refresh that failed nothing is due for a minute; one that succeeded, or a future record, holds nothing back', () => {
  const failed: RefreshAttempt = { v: 1, at: NOW, code: 'no_token' };
  const due = (attempt: RefreshAttempt, now: number) => refreshDue({ snapshot: { status: 'missing' }, session: bound([4]), pins: [], now, attempt });
  assert.equal(due(failed, NOW + MINUTE - 1), false);
  assert.equal(due(failed, NOW + MINUTE), true);
  assert.equal(due({ ...failed, code: null }, NOW + 1), true);
  assert.equal(due({ ...failed, at: NOW + 60 * MINUTE }, NOW), true, 'a clock that moved back must not hold refreshes off');
});
