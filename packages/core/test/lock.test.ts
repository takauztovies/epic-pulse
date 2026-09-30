import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock, releaseLock, touchLock } from '../src/lock.js';
import { tempDir } from './repo-helpers.js';

const STALE_MS = 60_000;

function lockFile(t: Parameters<typeof tempDir>[0]): string {
  return join(tempDir(t), 'nested', 'refresh.lock');
}

test('only one holder at a time, and the lock is reusable after release', async (t) => {
  const path = lockFile(t);
  const first = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(first);
  assert.equal(await acquireLock(path, { now: Date.now(), staleMs: STALE_MS }), undefined);
  await releaseLock(first);
  assert.ok(await acquireLock(path, { now: Date.now(), staleMs: STALE_MS }));
});

test('twelve simultaneous acquirers: exactly one wins', async (t) => {
  const path = lockFile(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => acquireLock(path, { now: Date.now(), staleMs: STALE_MS })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('a lock older than the stale window is taken over; a fresh one is not', async (t) => {
  const path = lockFile(t);
  const dead = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(dead);
  const justUnderLimit = (Date.now() - STALE_MS + 5000) / 1000;
  utimesSync(path, justUnderLimit, justUnderLimit);
  assert.equal(await acquireLock(path, { now: Date.now(), staleMs: STALE_MS }), undefined);
  const old = (Date.now() - STALE_MS - 5000) / 1000;
  utimesSync(path, old, old);
  const taker = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(taker);
  assert.notEqual(taker.token, dead.token);
});

test('a holder that was taken over does not delete the new holder\'s lock when it releases', async (t) => {
  const path = lockFile(t);
  const old = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(old);
  const past = (Date.now() - STALE_MS - 5000) / 1000;
  utimesSync(path, past, past);
  const current = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(current);
  await releaseLock(old);
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token, current.token);
});

test('touching a lock renews its claim so a slow refresh is not taken over', async (t) => {
  const path = lockFile(t);
  const held = await acquireLock(path, { now: Date.now(), staleMs: STALE_MS });
  assert.ok(held);
  const past = (Date.now() - STALE_MS - 5000) / 1000;
  utimesSync(path, past, past);
  await touchLock(held, Date.now());
  assert.equal(await acquireLock(path, { now: Date.now(), staleMs: STALE_MS }), undefined);
});
