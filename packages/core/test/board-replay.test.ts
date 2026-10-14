import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { runBoard } from '../src/board-fetch.js';
import { parseBoardPage } from '../src/board-query.js';
import { boardEntry } from '../src/board.js';
import type { RawResponse } from '../src/github.js';
import { acquireLock } from '../src/lock.js';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import type { Context, Run } from '../src/refresh-batch.js';
import { EPIC_TTL_MS } from '../src/refresh-plan.js';
import type { Board } from '../src/schemas/board.js';
import { emptySnapshot, readSnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';
import { boundRegistry } from './refresh-helpers.js';
import { replayServer, type ReplayedRequest } from './replay-server.js';
import { tempDir } from './repo-helpers.js';
import { demo, noGhEnv } from './snapshot-helpers.js';

// The board read through the real fetch, parse and paging loop, against a
// replay server (replay-server.ts) that serves recorded responses: what
// board.test.ts and board-refresh.test.ts can not reach offline, the loop in
// readBoard and the gates in runBoard. The server's address goes in as `githubApi`,
// and every token here is a made-up one, in an environment of the test's own, so
// the user's credentials never reach it. The numbers asserted here are literals
// on purpose: a test that imported BOARD_MAX_PAGES would follow it when it moves.
const T0 = Date.parse('2026-10-12T12:00:00Z');
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;
const NOT_FOUND: RawResponse = { status: 404, body: { message: 'Not Found' }, remaining: undefined, retryAfter: false };

// The recorded demo board (#4 Done, #5 Todo, #6 In Progress) as read at `at`.
function demoBoard(at: number): Board {
  const page = parseBoardPage(loadFixture('board-demo'));
  assert.ok(page.ok);
  return boardEntry(PROJECT, [page.value], at);
}

async function started(t: TestContext, githubApi: string, board?: Board): Promise<{ readonly run: Run; readonly ctx: Context }> {
  const lock = await acquireLock(join(tempDir(t), 'refresh.lock'), { now: T0, staleMs: 60_000 });
  assert.ok(lock, 'the lock is free');
  const snapshot = board === undefined ? emptySnapshot(T0) : { ...emptySnapshot(T0), board };
  return {
    run: { now: T0, snapshot, requests: 0, points: 0, failure: null },
    ctx: { tokens: new Map([['github.com', 'test-token']]), lock, clock: () => T0, project: PROJECT, githubApi },
  };
}

// The recording of the demo board's first page says there are more, with the one
// cursor it was recorded with. A board that goes on for ever is the recorded body
// again with its endCursor swapped for a new one each time: pages beyond the
// recording, which no board of this size has, only to see where the reader stops.
function pageEnding(cursor: string): RawResponse {
  const recorded = loadFixture('board-paged');
  const page = parseBoardPage(recorded);
  assert.ok(page.ok && page.value.next !== null, 'the recording has a page after it');
  const swapped = JSON.stringify(recorded.body).replace(JSON.stringify(page.value.next), () => JSON.stringify(cursor));
  return { ...recorded, body: JSON.parse(swapped) as unknown };
}

test('a board that never ends is read for five pages and no more, and says it was cut', async (t) => {
  const replay = await replayServer(t, (request) => pageEnding(`cursor-${request.index + 1}`));
  const { run, ctx } = await started(t, replay.origin);
  const read = await runBoard(run, [demo(1)], ctx);
  assert.equal(replay.requests.length, 5);
  assert.deepEqual(replay.requests.map((request) => request.variables['after']), [undefined, 'cursor-1', 'cursor-2', 'cursor-3', 'cursor-4']);
  assert.equal(replay.requests.some((request) => request.variables['after'] === 'cursor-5'), false, 'the sixth page is never asked for');
  assert.deepEqual([read.requests, read.points, read.snapshot.usage.points], [5, 5, 5], 'a point a page');
  assert.deepEqual([read.snapshot.board?.truncated, read.snapshot.board?.error], [true, null]);
  assert.deepEqual(read.snapshot.board?.items, { 'takauztovies/epic-pulse#4': 'done' }, 'what it read is kept');
});

// GitHub's answer to a query past the token's hour: a 200 whose one error is
// RATE_LIMITED, with x-ratelimit-remaining at 0 (the shape board.test.ts parses).
// Constructed, since recording one would spend the hour.
const RATE_LIMITED: RawResponse = {
  status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 0.' }] }, remaining: 0, retryAfter: false,
};

test('a rate-limited board read keeps the last board through the run, and backs the run off', async (t) => {
  const last = demoBoard(T0 - EPIC_TTL_MS);
  assert.equal(Object.keys(last.items).length, 3, 'there is something to keep');
  const replay = await replayServer(t, () => RATE_LIMITED);
  const { run, ctx } = await started(t, replay.origin, last);
  const read = await runBoard(run, [demo(1)], ctx);
  assert.equal(replay.requests.length, 1);
  assert.deepEqual(read.snapshot.board, { ...last, fetchedAt: T0, error: 'rate_limited' });
  assert.equal(read.snapshot.rateLimit?.remaining, 0);
});

test('a board read within its time to live makes no request, and a board past it makes exactly one', async (t) => {
  const replay = await replayServer(t, () => loadFixture('board-demo'));
  const { run, ctx } = await started(t, replay.origin, demoBoard(T0 - EPIC_TTL_MS));
  const due = await runBoard(run, [demo(1)], ctx);
  assert.equal(replay.requests.length, 1, 'the control: a board that is due is read, so a request would show');
  assert.equal(due.snapshot.board?.fetchedAt, T0);
  assert.deepEqual(await runBoard(due, [demo(1)], ctx), due);
  assert.equal(replay.requests.length, 1, 'read a moment ago, it is not read again');
});

// The options whose names every object inherits a value under, or looks like it
// might: `Constructor` is the one that reaches the table, as `constructor`.
const INHERITED = ['Constructor', '__proto__', 'toString', 'hasOwnProperty'];

// The recorded demo board with its Todo option (#5) renamed.
function renamedBoard(option: string): RawResponse {
  const recording = loadFixture('board-demo');
  const text = JSON.stringify(recording.body).replace(JSON.stringify('Todo'), () => JSON.stringify(option));
  assert.ok(text.includes(JSON.stringify(option)), 'the rename found its option');
  return { ...recording, body: JSON.parse(text) as unknown };
}

const documentOf = (request: ReplayedRequest) => /^query (\w+)/.exec(request.query)?.[1];

// The recorded Phase A, board and Phase B of the demo epic #1, by document.
function recorded(request: ReplayedRequest, board: RawResponse): RawResponse {
  const answers = new Map([['PhaseA', loadFixture('phase-a')], ['Board', board], ['PhaseB', loadFixture('phase-b-board')]]);
  return answers.get(documentOf(request) ?? '') ?? NOT_FOUND;
}

// #5 is open and carries the renamed option, so it keeps its derived status; #6
// still takes its mapped one, and #4 is closed, which a board can not reopen.
const ROWS = [[2, 'done', 'derived'], [3, 'dropped', 'derived'], [4, 'done', 'derived'], [5, 'in_review', 'derived'], [6, 'in_progress', 'board'], [7, 'todo', 'derived']];

for (const option of INHERITED) {
  test(`a board option named ${option} maps to nothing, and the refresh stores the board and the epic whole`, async (t) => {
    const paths = await boundRegistry(t, [demo(1)]);
    const replay = await replayServer(t, (request) => recorded(request, renamedBoard(option)));
    const env = noGhEnv(t, { GH_TOKEN: 'replay' });
    const outcome = await refresh({ dir: paths.dir, now: Date.now(), env, project: PROJECT, githubApi: replay.origin });
    assert.deepEqual(replay.requests.map(documentOf), ['PhaseA', 'Board', 'PhaseB']);
    assert.deepEqual(outcome.status === 'done' ? [outcome.requests, outcome.error] : outcome, [3, null]);
    const read = await readSnapshot(paths.snapshotFile);
    assert.ok(read.status === 'ok');
    const epic = read.snapshot.epics[refKey(demo(1))];
    assert.deepEqual([epic?.error, epic?.children.map((child) => [child.number, child.status, child.statusSource])], [null, ROWS]);
    assert.deepEqual(read.snapshot.board?.items, { 'takauztovies/epic-pulse#4': 'done', 'takauztovies/epic-pulse#6': 'in_progress' });
    assert.deepEqual(read.snapshot.board?.unmapped, [option]);
  });
}
