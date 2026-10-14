import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { boardDocument, parseBoardPage, type BoardPage } from '../src/board-query.js';
import { BOARD_MAX_PAGES, BOARD_RETRY_MS, boardDue, boardEntry, boardFailed, boardFor, nextCursor } from '../src/board.js';
import type { RawResponse } from '../src/github.js';
import { EPIC_TTL_MS } from '../src/refresh-plan.js';
import { BOARD_LIMITS } from '../src/schemas/board.js';
import { SnapshotSchema } from '../src/schemas/snapshot.js';
import { emptySnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;

function page(name: string): BoardPage {
  const parsed = parseBoardPage(loadFixture(name));
  assert.ok(parsed.ok, `${name} parses`);
  return parsed.value;
}

test('the recorded demo board reads as its three issues and their Status options, on one page', () => {
  assert.deepEqual(page('board-demo'), {
    items: [
      { key: 'takauztovies/epic-pulse#4', option: 'Done' },
      { key: 'takauztovies/epic-pulse#5', option: 'Todo' },
      { key: 'takauztovies/epic-pulse#6', option: 'In Progress' },
    ],
    next: null,
  });
});

test('the board document is read-only, separate from the phase documents, and checks its number', () => {
  const document = boardDocument(3);
  assert.match(document, /^query Board\(/);
  assert.doesNotMatch(document, /mutation|subscription|repository\(owner/);
  assert.match(document, /items\(first: 100, after: \$after\)/);
  assert.throws(() => boardDocument(0));
});

test('a token without read:project, or a project that is not there, is a refusal with a code', () => {
  const scope = parseBoardPage(loadFixture('board-no-scope'));
  assert.deepEqual(scope.ok ? null : scope.error, { code: 'forbidden', detail: null });
  const missing = parseBoardPage(loadFixture('board-not-found'));
  assert.deepEqual(missing.ok ? null : missing.error, { code: 'not_found', detail: null });
  const unauthorized = parseBoardPage(loadFixture('error-bad-credentials'));
  assert.equal(unauthorized.ok ? null : unauthorized.error.code, 'unauthorized');
});

test('a page that says there are more is followed, until the fifth page', () => {
  const first = page('board-paged');
  assert.deepEqual(first.items, [{ key: 'takauztovies/epic-pulse#4', option: 'Done' }]);
  assert.equal(typeof first.next, 'string');
  assert.equal(nextCursor(first, 1), first.next);
  assert.equal(nextCursor(first, BOARD_MAX_PAGES - 1), first.next);
  assert.equal(nextCursor(first, BOARD_MAX_PAGES), undefined, 'the cap: no sixth page');
  assert.equal(nextCursor(page('board-demo'), 1), undefined);
});

test('a board cut at the cap is flagged truncated and keeps what it read', () => {
  const capped = boardEntry(PROJECT, Array.from({ length: BOARD_MAX_PAGES }, () => page('board-paged')), T0);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.items, { 'takauztovies/epic-pulse#4': 'done' });
  assert.equal(boardEntry(PROJECT, [page('board-demo')], T0).truncated, false);
});

test('a board entry keeps mapped items only and names the unmapped options', () => {
  const project = parseProject({ owner: 'takauztovies', number: 3, statusMap: { 'In Progress': 'in_review' } })!;
  const odd = parseProject({ owner: 'takauztovies', number: 3, statusMap: {} })!;
  assert.deepEqual(boardEntry(project, [page('board-demo')], T0).items, {
    'takauztovies/epic-pulse#4': 'done', 'takauztovies/epic-pulse#5': 'todo', 'takauztovies/epic-pulse#6': 'in_review',
  });
  const renamed: BoardPage = { items: page('board-demo').items.map((item) => (item.option === 'Todo' ? { ...item, option: 'Icebox' } : item)), next: null };
  const entry = boardEntry(odd, [renamed], T0);
  assert.deepEqual(Object.keys(entry.items), ['takauztovies/epic-pulse#4', 'takauztovies/epic-pulse#6']);
  assert.deepEqual(entry.unmapped, ['Icebox']);
  assert.ok(SnapshotSchema.safeParse({ ...emptySnapshot(T0), board: entry }).success);
});

test('no read:project leaves no items and is asked again after 30 minutes, not with every refresh', () => {
  const read = boardEntry(PROJECT, [page('board-demo')], T0);
  const scope = boardFailed(read, PROJECT, { failure: { code: 'forbidden', detail: null }, now: T0 });
  assert.equal(scope.error, 'scope');
  assert.deepEqual(scope.items, {});
  assert.equal(boardDue(scope, T0 + EPIC_TTL_MS), false);
  assert.equal(boardDue(scope, T0 + BOARD_RETRY_MS - 1), false);
  assert.equal(boardDue(scope, T0 + BOARD_RETRY_MS), true);
});

test('a network failure keeps the last board and is asked again with the epics', () => {
  const read = boardEntry(PROJECT, [page('board-demo')], T0);
  const failed = boardFailed(read, PROJECT, { failure: { code: 'network', detail: 'ECONNRESET' }, now: T0 + 1 });
  assert.equal(failed.error, 'network');
  assert.deepEqual(failed.items, read.items);
  assert.equal(boardDue(failed, T0 + 1 + EPIC_TTL_MS), true);
  assert.equal(boardDue(read, T0 + EPIC_TTL_MS - 1), false);
  assert.equal(boardDue(undefined, T0), true);
});

// `fetchedAt` is the last attempt, which is what paces the next one, so after a
// failure it is the failure's time. `readAt` is when the items were read, for
// doctor to say how old the statuses are: it must survive every failure that
// keeps them, and be none where they were not kept.
test('a failed read keeps when its items were read, however many fail after it, and none where they were not kept', () => {
  const read = boardEntry(PROJECT, [page('board-demo')], T0);
  const once = boardFailed(read, PROJECT, { failure: { code: 'network', detail: null }, now: T0 + 1 });
  const twice = boardFailed(once, PROJECT, { failure: { code: 'timeout', detail: null }, now: T0 + 2 });
  assert.deepEqual([read.readAt, once.readAt, twice.readAt, twice.fetchedAt], [T0, T0, T0, T0 + 2]);
  const refused = boardFailed(read, PROJECT, { failure: { code: 'unauthorized', detail: null }, now: T0 + 1 });
  assert.deepEqual([refused.readAt, refused.items], [null, {}]);
  assert.equal(boardFailed(undefined, PROJECT, { failure: { code: 'network', detail: null }, now: T0 }).readAt, null);
});

// Doctor prints `readAt` as a date, and toISOString throws past the last instant
// a Date holds: a time beyond it is a malformed entry, which reads as no board.
test('a board whose read time is past the last date a Date holds reads as none', () => {
  assert.doesNotThrow(() => new Date(BOARD_LIMITS.maxTimeMs).toISOString());
  assert.throws(() => new Date(BOARD_LIMITS.maxTimeMs + 1).toISOString(), RangeError);
  const entry = boardEntry(PROJECT, [page('board-demo')], T0);
  const stored = (readAt: number) => SnapshotSchema.parse({ ...emptySnapshot(T0), board: { ...entry, readAt } }).board;
  assert.equal(stored(BOARD_LIMITS.maxTimeMs)?.readAt, BOARD_LIMITS.maxTimeMs);
  assert.equal(stored(BOARD_LIMITS.maxTimeMs + 1), undefined);
});

// A board entry from before `readAt` existed has no time to say its items are
// from, so it is a malformed entry like any other: it reads as no board and is
// read again with the epics, rather than shown with statuses nobody can date.
test('a board entry written before readAt existed reads as none', () => {
  const entry = boardEntry(PROJECT, [page('board-demo')], T0);
  const older = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'readAt'));
  const stored = (board: unknown) => SnapshotSchema.parse({ ...emptySnapshot(T0), board }).board;
  assert.deepEqual(stored(entry), entry, 'with its read time it is a board');
  assert.equal(stored(older), undefined);
});

// GitHub's answer to a query past the token's hour: a 200 whose one error is
// RATE_LIMITED, with x-ratelimit-remaining at 0. Constructed, since recording
// one would spend the hour. A rate-limit 403 and a 429 mean the same.
const RATE_LIMITED: RawResponse = {
  status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 0.' }] }, remaining: 0, retryAfter: false,
};
const RATE_LIMITS: readonly RawResponse[] = [RATE_LIMITED, { ...RATE_LIMITED, status: 403 }, { ...RATE_LIMITED, status: 403, remaining: 4000, retryAfter: true }, { ...RATE_LIMITED, status: 429, remaining: undefined }];

test('a rate-limited board read keeps the last board, marked rate_limited, and is asked again with the epics', () => {
  const read = boardEntry(PROJECT, [page('board-demo')], T0);
  for (const res of RATE_LIMITS) {
    const answer = parseBoardPage(res);
    assert.ok(!answer.ok, `HTTP ${res.status}`);
    const limited = boardFailed(read, PROJECT, { failure: answer.error, now: T0 + 1 });
    assert.deepEqual(limited, { ...read, fetchedAt: T0 + 1, error: 'rate_limited' }, `HTTP ${res.status}`);
    assert.equal(boardDue(limited, T0 + EPIC_TTL_MS), false, `HTTP ${res.status}`);
    assert.equal(boardDue(limited, T0 + 1 + EPIC_TTL_MS), true, `HTTP ${res.status}`);
  }
});

test('a board for another project block, or for none, is dropped when a refresh starts', () => {
  const snapshot = { ...emptySnapshot(T0), board: boardEntry(PROJECT, [page('board-demo')], T0) };
  assert.equal(boardFor(snapshot, PROJECT), snapshot);
  assert.equal('board' in boardFor(snapshot, { ...PROJECT, number: 4 }), false);
  assert.equal('board' in boardFor(snapshot, undefined), false);
  assert.equal(boardFor(emptySnapshot(T0), PROJECT).board, undefined);
});

test('an old snapshot with no board still parses, and a malformed board reads as none', () => {
  const old = emptySnapshot(T0);
  assert.ok(SnapshotSchema.safeParse(old).success);
  const broken = SnapshotSchema.safeParse({ ...old, board: { project: 'x' } });
  assert.ok(broken.success);
  assert.equal(broken.data.board, undefined);
});
