import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { readSnapshot } from '../src/snapshot.js';
import { readUsage, USAGE_FILE } from '../src/usage-ledger.js';
import { boundRegistry } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';
import { demo } from './snapshot-helpers.js';

// Real GitHub: the public demo board, https://github.com/users/takauztovies/projects/3
// (#4 Done, #5 Todo, #6 In Progress). Skipped unless EPIC_PULSE_LIVE=1. The
// repository's own .epic-pulse.json names no board, so the other live tests,
// and CI, whose GITHUB_TOKEN can not read a user's project, never read it.
const live = { skip: process.env['EPIC_PULSE_LIVE'] !== '1' };
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;
const NO_PROJECT_TOKEN = 'EPIC_PULSE_NO_PROJECT_TOKEN';

async function boardRun(t: TestContext, tokens?: Readonly<Record<string, string>>) {
  const paths = await boundRegistry(t, [demo(4)]);
  const env = { ...process.env, EPIC_PULSE_CACHE_DIR: tempDir(t) };
  const outcome = await refresh({ dir: paths.dir, now: Date.now(), env, project: PROJECT, ...(tokens ? { tokens } : {}) });
  const read = await readSnapshot(paths.snapshotFile);
  assert.ok(read.status === 'ok');
  return { paths, env, outcome, snapshot: read.snapshot };
}

test('live: the demo board sets the open sub-issues on it, and is charged a point per page', live, async (t) => {
  const { paths, env, outcome, snapshot } = await boardRun(t);
  if (snapshot.board?.error === 'scope') {
    t.skip('the token lacks read:project, so GitHub refuses the board; run `gh auth refresh -s read:project` to cover this test');
    return;
  }
  assert.ok(outcome.status === 'done' && outcome.error === null);
  assert.deepEqual(snapshot.board?.items, { 'takauztovies/epic-pulse#4': 'done', 'takauztovies/epic-pulse#5': 'todo', 'takauztovies/epic-pulse#6': 'in_progress' });
  assert.deepEqual([snapshot.board?.error, snapshot.board?.truncated, snapshot.board?.unmapped], [null, false, []]);
  const children = snapshot.epics[refKey(demo(1))]!.children;
  const five = children.find((child) => child.number === 5);
  assert.deepEqual([five?.status, five?.statusSource], ['todo', 'board']);
  const charged = (await readUsage(join(env['EPIC_PULSE_CACHE_DIR'], USAGE_FILE))).filter((line) => line.points === 1);
  assert.ok(charged.length >= 2, 'Phase A and the one board page are each a one-point line in the ledger');
  t.diagnostic(`board refresh: ${JSON.stringify(outcome)}`);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now() + 1000, env, project: PROJECT }), { status: 'done', requests: 0, points: 0, error: null });
});

test('live: a token without read:project records the scope error and leaves every status derived', live, async (t) => {
  const token = process.env[NO_PROJECT_TOKEN];
  if (!token) {
    t.skip(`needs ${NO_PROJECT_TOKEN}, a token without the project scope, to see GitHub refuse the board`);
    return;
  }
  const { outcome, snapshot } = await boardRun(t, { 'github.com': token });
  assert.ok(outcome.status === 'done' && outcome.error === null, 'a refused board does not fail Phase B');
  assert.deepEqual([snapshot.board?.error, snapshot.board?.items], ['scope', {}]);
  assert.ok(snapshot.epics[refKey(demo(1))]!.children.every((child) => child.statusSource === 'derived'));
});
