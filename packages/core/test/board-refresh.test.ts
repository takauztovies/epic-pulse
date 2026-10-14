import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { parseBoardPage } from '../src/board-query.js';
import { boardEntry } from '../src/board.js';
import { refresh } from '../src/refresh.js';
import { EPIC_TTL_MS } from '../src/refresh-plan.js';
import { readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { boundRegistry } from './refresh-helpers.js';
import { loadFixture } from './helpers.js';
import { demo, demoSnapshot, noGhEnv } from './snapshot-helpers.js';

// Real refreshes of real temp registries, offline: what the board step does
// when it can not, or need not, send anything. The read itself is live-tested
// (board.live.test.ts).
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;

function demoBoard(now: number) {
  const page = parseBoardPage(loadFixture('board-demo'));
  assert.ok(page.ok);
  return boardEntry(PROJECT, [page.value], now);
}

test('a configured board changes nothing about a refresh that has no token', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4), demo(8)]);
  const fetched = demoSnapshot(now - EPIC_TTL_MS);
  await writeSnapshot(paths.snapshotFile, fetched);
  const outcome = await refresh({ dir: paths.dir, now, env: noGhEnv(t), project: PROJECT });
  assert.deepEqual(outcome, { status: 'done', requests: 0, points: 0, error: 'no_token' });
  const read = await readSnapshot(paths.snapshotFile);
  assert.ok(read.status === 'ok');
  assert.deepEqual(read.snapshot.epics, fetched.epics);
  assert.equal(read.snapshot.board, undefined, 'no board was read, and none is invented');
});

test('the board stays while its project block does, and goes when the block goes or changes', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4), demo(8)]);
  const board = demoBoard(now);
  const at = async (project: typeof PROJECT | undefined) => {
    await writeSnapshot(paths.snapshotFile, { ...demoSnapshot(now), board });
    assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t), project }), { status: 'done', requests: 0, points: 0, error: null });
    const read = await readSnapshot(paths.snapshotFile);
    return read.status === 'ok' ? read.snapshot.board : read.status;
  };
  assert.deepEqual(await at(PROJECT), board);
  assert.equal(await at(undefined), undefined);
  assert.equal(await at({ ...PROJECT, number: 4 }), undefined);
  assert.equal(await at({ ...PROJECT, statusMap: { todo: 'dropped' } }), undefined);
});
