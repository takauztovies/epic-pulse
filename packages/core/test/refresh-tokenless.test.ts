import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { EPIC_TTL_MS } from '../src/refresh-plan.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { boundRegistry, cachedEpic, invalid, sendingEnv } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot, noGhEnv } from './snapshot-helpers.js';

// The snapshot is shared by every refresher of the repository: one with a
// token (a VS Code sign-in) and one without (a terminal's status line). The
// one without has learned nothing about the epics and must not mark them.
test('a refresh without a token leaves every epic as the refresh that had one left it', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4), demo(8)]);
  const fetched = demoSnapshot(now - EPIC_TTL_MS); // both epics are due again
  await writeSnapshot(paths.snapshotFile, fetched);
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'no_token' });
  const read = await readSnapshot(paths.snapshotFile);
  assert.ok(read.status === 'ok');
  assert.deepEqual(read.snapshot.epics, fetched.epics);
  assert.equal(read.snapshot.error, 'no_token', 'the snapshot still says why this run fetched nothing');
});

// The other direction: a request that went out and failed did learn something,
// that the data could not be refreshed, and marks the epic with it.
test('a refresh whose request failed marks the epic it asked for, and keeps its data', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [invalid(4)]);
  const old = cachedEpic(invalid(4), now - EPIC_TTL_MS);
  const issues = { [refKey(invalid(4))]: { epic: invalid(4), resolvedAt: now } };
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), issues, epics: { [refKey(invalid(4))]: old } });
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: sendingEnv(t, tempDir(t)) }), { status: 'done', requests: 1, points: 0, error: 'network' });
  const read = await readSnapshot(paths.snapshotFile);
  assert.deepEqual(read.status === 'ok' ? read.snapshot.epics[refKey(invalid(4))] : read.status, { ...old, error: 'network' });
});
