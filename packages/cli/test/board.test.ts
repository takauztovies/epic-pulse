import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardEntry, boardFailed, parseBoardPage, parseProject, projectToEnv, readSnapshot, writeSnapshot, type Board, type BoardPage, type ErrorCode } from '@epic-pulse/core';
import { demoSnapshot } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, type Sandbox } from './helpers.js';

// The project block from the repository's .epic-pulse.json, through the real
// bundle: the refresh reads it (or the status line's hand-over of it), and
// doctor reports the board. Offline: no token, so nothing is fetched.
const BLOCK = { owner: 'takauztovies', number: 3 };
const PROJECT = parseProject(BLOCK)!;
const NOW = Date.now();
const RECORDING = new URL('../../../fixtures/graphql/board-demo.json', import.meta.url);

// The recorded demo board (#4 Done, #5 Todo, #6 In Progress), with Todo renamed
// when asked, so one option maps to nothing.
function demoBoard(rename?: string): Board {
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as { status: number; body: unknown };
  const page = parseBoardPage({ status: recording.status, body: recording.body, remaining: undefined, retryAfter: false });
  assert.ok(page.ok);
  const items = page.value.items.map((item) => (rename !== undefined && item.option === 'Todo' ? { ...item, option: rename } : item));
  return boardEntry(PROJECT, [{ ...page.value, items }], NOW);
}

async function boardAfterRefresh(repo: string, env: NodeJS.ProcessEnv): Promise<Board | undefined> {
  await writeSnapshot(registryOf(repo).snapshotFile, { ...demoSnapshot(NOW), board: demoBoard() });
  await runCli(['refresh'], { cwd: repo, env });
  const read = await readSnapshot(registryOf(repo).snapshotFile);
  assert.ok(read.status === 'ok');
  return read.snapshot.board;
}

test('refresh reads the project block from the repository, or from the status line hand-over', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  assert.equal(await boardAfterRefresh(repo, env), undefined, 'no block: a board left in the snapshot is dropped');
  assert.deepEqual(await boardAfterRefresh(repo, { ...env, ...projectToEnv(PROJECT) }), demoBoard(), 'the hand-over keeps it');
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: BLOCK }));
  assert.deepEqual(await boardAfterRefresh(repo, env), demoBoard(), 'the block in .epic-pulse.json keeps it');
});

// The board line of `epic-pulse doctor`, for whatever snapshot is on disk.
async function doctorBoardLine(repo: string, box: Sandbox): Promise<string | undefined> {
  const run = await runCli(['doctor'], { cwd: repo, env: cliEnv(box) });
  assert.equal(run.code, 0);
  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('board:'));
  return line?.trim().replace(/^board:\s+/, '');
}

async function boardLine(repo: string, box: Sandbox, board: Board | undefined): Promise<string | undefined> {
  await writeSnapshot(registryOf(repo).snapshotFile, { ...demoSnapshot(NOW), ...(board ? { board } : {}) });
  return doctorBoardLine(repo, box);
}

test('doctor says nothing of a board the repository does not configure', async (t) => {
  assert.equal(await boardLine(demoRepo(t), sandbox(t), demoBoard()), undefined);
});

test('doctor names the scope a refused board needs, and the options that map to nothing', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: BLOCK }));
  assert.equal(await boardLine(repo, box, undefined), 'takauztovies project 3, field Status: not read yet');
  const scope = boardFailed(demoBoard(), PROJECT, { failure: { code: 'forbidden', detail: null }, now: NOW });
  assert.equal(await boardLine(repo, box, scope), 'token lacks read:project — `gh auth refresh -s read:project`');
  assert.equal(await boardLine(repo, box, demoBoard()), 'takauztovies project 3, field Status: 3 items mapped');
  assert.equal(await boardLine(repo, box, demoBoard('Icebox')), 'takauztovies project 3, field Status: 2 items mapped; unmapped options: Icebox (map them under "statusMap")');
});

// Option names are chosen by whoever can edit the board, and doctor prints them
// to a terminal. Todo and In Progress renamed in GitHub's answer itself: an
// escape sequence and a one-byte CSI (U+009B), then a right-to-left override
// (U+202E) before an emoji held together by a ZWJ. Neither maps to a status.
const HOSTILE: Readonly<Record<string, string>> = { Todo: '\u001b[2J\u009b31mBlocked', 'In Progress': '\u202e\u{1F469}\u200d\u{1F4BB} Pairing' };
const SHOWN = ['?[2J?31mBlocked', '?\u{1F469}\u200d\u{1F4BB} Pairing'];
const UNSAFE = /\p{Cc}|[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function hostileAnswer(): Board {
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as { status: number; body: unknown };
  const renamed = Object.entries(HOSTILE).reduce((text, [from, to]) => text.replace(JSON.stringify(from), () => JSON.stringify(to)), JSON.stringify(recording.body));
  const page = parseBoardPage({ status: recording.status, body: JSON.parse(renamed) as unknown, remaining: undefined, retryAfter: false });
  assert.ok(page.ok);
  return boardEntry(PROJECT, [page.value], NOW);
}

test('doctor prints an option name with ? for its control and bidi characters, and its emoji whole', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: BLOCK }));
  const expected = `takauztovies project 3, field Status: 1 item mapped; unmapped options: ${SHOWN.join(', ')} (map them under "statusMap")`;
  const line = await boardLine(repo, box, hostileAnswer());
  assert.equal(line, expected);
  assert.doesNotMatch(line ?? '', UNSAFE);
  const stored = JSON.parse(readFileSync(registryOf(repo).snapshotFile, 'utf8')) as { readonly board: Board };
  assert.deepEqual(stored.board.unmapped, SHOWN, 'the snapshot stores them so');
  // As a version before the sanitiser stored them: the names GitHub sent.
  writeFileSync(registryOf(repo).snapshotFile, JSON.stringify({ ...demoSnapshot(NOW), board: { ...stored.board, unmapped: Object.values(HOSTILE) } }));
  assert.equal(await doctorBoardLine(repo, box), expected, 'a snapshot an older version wrote');
});

// `field` is the repository's own text, from .epic-pulse.json, and doctor prints
// it: an escape sequence, a one-byte CSI, an override, a line separator and an
// Arabic letter mark. The separator is not at an end, where the block's trim()
// would take it. GitHub is still asked for the field as it was written.
const FIELD = 'St\u001b[2J\u009b\u202ea\u2028t\u061cus';
const LABEL = 'takauztovies project 3, field St?[2J??a?t?us';

function failed(previous: Board | undefined, code: ErrorCode, now: number): Board {
  return boardFailed(previous, PROJECT, { failure: { code, detail: null }, now });
}

test('doctor prints a field name with ? for its control and bidi characters, in every state of the board', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const project = parseProject({ ...BLOCK, field: FIELD })!;
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: { ...BLOCK, field: FIELD } }));
  const states: readonly (readonly [Board | undefined, string])[] = [
    [undefined, 'not read yet'],
    [boardEntry(project, [{ items: [], next: null }], NOW), '0 items mapped'],
    [boardFailed(undefined, project, { failure: { code: 'network', detail: null }, now: NOW }), 'the last read failed (network); statuses are derived'],
  ];
  for (const [board, said] of states) {
    const line = await boardLine(repo, box, board);
    assert.equal(line, `${LABEL}: ${said}`);
    assert.doesNotMatch(line ?? '', UNSAFE);
  }
  assert.equal(project.field, FIELD, 'GitHub is sent the name as written');
});

// After a failed read: a network, timeout or rate_limited failure keeps the
// last board's items, so the statuses are from the read that made them, at its
// time, however many reads failed since. Any other refusal left none, as did a
// first read that failed and a last board that mapped no item.
const NOTHING_MAPPED: BoardPage = { items: [{ key: 'takauztovies/epic-pulse#5', option: 'Icebox' }], next: null };

test('doctor says a failed read left the statuses from the last good read, at its time, or derived when it kept no item', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: BLOCK }));
  const at = new Date(NOW).toISOString();
  const limited = failed(demoBoard(), 'rate_limited', NOW + 1000);
  const said: readonly (readonly [Board, string])[] = [
    [limited, `the last read failed (rate_limited); statuses are from the last good read at ${at}`],
    [failed(limited, 'network', NOW + 2000), `the last read failed (network); statuses are from the last good read at ${at}`],
    [failed(demoBoard(), 'unauthorized', NOW + 1000), 'the last read failed (unauthorized); statuses are derived'],
    [failed(undefined, 'timeout', NOW), 'the last read failed (timeout); statuses are derived'],
    [failed(boardEntry(PROJECT, [NOTHING_MAPPED], NOW), 'network', NOW + 1000), 'the last read failed (network); statuses are derived'],
  ];
  for (const [board, text] of said) assert.equal(await boardLine(repo, box, board), `takauztovies project 3, field Status: ${text}`);
});

// A snapshot is a file. A read time that no Date can print would make doctor
// throw where it must report, so it is a malformed board: it reads as none.
test('doctor still reports a board whose read time is no date', async (t) => {
  const repo = demoRepo(t);
  writeFileSync(join(repo, '.epic-pulse.json'), JSON.stringify({ project: BLOCK }));
  const corrupt = { ...failed(demoBoard(), 'network', NOW + 1000), readAt: 9e15 };
  await writeSnapshot(registryOf(repo).snapshotFile, demoSnapshot(NOW)); // makes the registry directory
  writeFileSync(registryOf(repo).snapshotFile, JSON.stringify({ ...demoSnapshot(NOW), board: corrupt }));
  assert.equal(await doctorBoardLine(repo, sandbox(t)), 'takauztovies project 3, field Status: not read yet');
});
