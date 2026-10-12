import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardEntry, boardFailed, parseBoardPage, parseProject, projectToEnv, readSnapshot, writeSnapshot, type Board } from '@epic-pulse/core';
import { demoSnapshot } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, type Sandbox } from './helpers.js';

// The project block from the repository's .epic-pulse.json, through the real
// bundle: the refresh reads it (or the status line's hand-over of it), and
// doctor reports the board. Offline: no token, so nothing is fetched.
const BLOCK = { owner: 'takauztovies', number: 3 };
const PROJECT = parseProject(BLOCK)!;
const NOW = Date.now();

// The recorded demo board (#4 Done, #5 Todo, #6 In Progress), with Todo renamed
// when asked, so one option maps to nothing.
function demoBoard(rename?: string): Board {
  const recording = JSON.parse(readFileSync(new URL('../../../fixtures/graphql/board-demo.json', import.meta.url), 'utf8')) as { status: number; body: unknown };
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

async function boardLine(repo: string, box: Sandbox, board: Board | undefined): Promise<string | undefined> {
  await writeSnapshot(registryOf(repo).snapshotFile, { ...demoSnapshot(NOW), ...(board ? { board } : {}) });
  const run = await runCli(['doctor'], { cwd: repo, env: cliEnv(box) });
  assert.equal(run.code, 0);
  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('board:'));
  return line?.trim().replace(/^board:\s+/, '');
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
