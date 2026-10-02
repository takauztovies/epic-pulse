import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsFor } from '../src/paths.js';
import { refresh } from '../src/refresh.js';
import { bind, invalid, sendingEnv, SESSION } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';

const HOUR = 3_600_000;

// The status line shows its own session's bindings however long the session
// has been quiet, so the refresh it starts names that session, and keeps its
// issues current along with the live sessions' and the pins.
test('the session that started a refresh is refreshed even when it is no longer live; others still need to be', async (t) => {
  const now = Date.now();
  const paths = pathsFor(tempDir(t));
  await bind(paths, [invalid(4)], now - 3 * HOUR); // quiet for three hours: not live, its binding still active
  const cache = tempDir(t);
  const at = (extra: NodeJS.ProcessEnv) => refresh({ dir: paths.dir, now, env: { ...sendingEnv(t, cache), ...extra } });
  assert.deepEqual(await at({}), { status: 'done', requests: 0, points: 0, error: null });
  assert.deepEqual(await at({ EPIC_PULSE_SESSION: '../escape' }), { status: 'done', requests: 0, points: 0, error: null });
  assert.deepEqual(await at({ EPIC_PULSE_SESSION: SESSION }), { status: 'done', requests: 1, points: 0, error: 'network' });
});
