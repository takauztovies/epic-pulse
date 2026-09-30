import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { extract } from '../src/extract.js';
import { resolveToken } from '../src/github.js';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { appendRegistryLine } from '../src/registry.js';
import { readSnapshot } from '../src/snapshot.js';
import { countStatuses, percentDone } from '../src/status.js';
import { bash, SESSION } from './extract-helpers.js';
import { git, makeRepo, tempDir } from './repo-helpers.js';
import { demo, filesUnder } from './snapshot-helpers.js';

// Real GitHub, the public demo repository, the user's own token. Skipped
// unless EPIC_PULSE_LIVE=1 (`pnpm test:live`).
const live = { skip: process.env['EPIC_PULSE_LIVE'] !== '1' };

// A checkout of the demo repo in which a session commented on #4 and tracked
// #8, recorded through the real hook path: payload, extract, registry.
export async function demoSession(t: TestContext): Promise<RegistryPaths> {
  const root = makeRepo(t).root;
  git(root, ['remote', 'add', 'origin', 'https://github.com/takauztovies/epic-pulse.git']);
  const paths = pathsFor(tempDir(t));
  for (const command of ['gh issue comment 4 --body "progress"', 'epic-pulse track 8']) {
    const { ev, binds, unbinds } = await extract(bash(command, root));
    assert.equal(binds.length, 1, command);
    assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: Date.now(), ev, binds, unbinds })).ok);
  }
  return paths;
}

test('live: a full refresh of the demo epics matches GitHub, then serves from cache', live, async (t) => {
  const paths = await demoSession(t);
  const first = await refresh({ dir: paths.dir, now: Date.now(), env: process.env });
  assert.equal(first.status === 'done' && first.error, null);
  t.diagnostic(`full refresh: ${JSON.stringify(first)}`);
  const read = await readSnapshot(paths.snapshotFile);
  assert.ok(read.status === 'ok');
  const epic = read.snapshot.epics[refKey(demo(1))]!;
  assert.deepEqual(countStatuses(epic.children), { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 });
  assert.equal(percentDone(countStatuses(epic.children)), 20);
  const checklist = countStatuses(read.snapshot.epics[refKey(demo(8))]!.children);
  assert.deepEqual([checklist.done, checklist.done + checklist.todo, checklist.dropped], [2, 4, 1]);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now() + 1000, env: process.env }), { status: 'done', requests: 0, points: 0, error: null });
});

test('live: the real token is on no file after a real refresh', live, async (t) => {
  const paths = await demoSession(t);
  const token = (await resolveToken('github.com', process.env))?.token;
  assert.ok(token && token.length > 10, 'a token is available for the live run');
  assert.equal((await refresh({ dir: paths.dir, now: Date.now(), env: process.env })).status, 'done');
  const files = filesUnder(paths.dir);
  assert.ok(files.includes(paths.snapshotFile));
  for (const file of files) assert.equal(readFileSync(file, 'utf8').includes(token), false, file);
});
