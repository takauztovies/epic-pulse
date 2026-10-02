import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { EPIC_TTL_MS, RESOLUTION_TTL_MS } from '../src/refresh-plan.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { boundRegistry, cachedEpic, invalid, sendingEnv, writeLedger } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';

// This repository's last refresh cost `points` a second ago and another one
// shares the hour, so it is paced for points x 3600 / 300 x 2 seconds.
const paced = (cache: string, dir: string, { now, points }: { readonly now: number; readonly points: number }) =>
  writeLedger(cache, [{ ts: now - 60_000, points: 3 }, { ts: now - 1000, points, mine: dir }]);

function chargedAt(cache: string, ts: number): readonly number[] {
  const lines = readFileSync(join(cache, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean);
  return lines.map((raw) => JSON.parse(raw) as { ts: number; points: number }).filter((line) => line.ts === ts).map((line) => line.points);
}

// #5 was never resolved, #6 resolved to epic #7 that was never fetched: both
// show "loading". #4 is cached: its resolution and its epic are both due again.
test('a paced repository still asks at once for what it has never resolved or fetched, and only for that', async (t) => {
  const now = Date.now();
  const cache = tempDir(t);
  const paths = await boundRegistry(t, [invalid(4), invalid(5), invalid(6)]);
  const old = cachedEpic(invalid(4), now - EPIC_TTL_MS - 1);
  await writeSnapshot(paths.snapshotFile, {
    ...emptySnapshot(now),
    issues: {
      [refKey(invalid(4))]: { epic: invalid(4), resolvedAt: now - RESOLUTION_TTL_MS },
      [refKey(invalid(6))]: { epic: invalid(7), resolvedAt: now - 60_000 },
    },
    epics: { [refKey(invalid(4))]: old },
  });
  paced(cache, paths.dir, { now, points: 1 });
  const outcome = await refresh({ dir: paths.dir, now, env: sendingEnv(t, cache) });
  assert.deepEqual(outcome, { status: 'done', requests: 2, points: 0, error: 'network' });
  assert.deepEqual(chargedAt(cache, now), [1, 3], 'Phase A for #5, then Phase B for epic #7 alone');
  const read = await readSnapshot(paths.snapshotFile);
  assert.deepEqual(read.status === 'ok' ? read.snapshot.epics[refKey(invalid(4))] : read.status, old, 'the cached epic waits its turn');
});

test('what pacing lets through is still held to the hourly cap', async (t) => {
  const now = Date.now();
  const cache = tempDir(t);
  const paths = await boundRegistry(t, [invalid(5)]);
  paced(cache, paths.dir, { now, points: 297 }); // the hour is spent: 3 + 297
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: sendingEnv(t, cache) }), { status: 'done', requests: 0, points: 0, error: 'budget' });
});
