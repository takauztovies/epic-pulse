import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { extract } from '../src/extract.js';
import { resolveToken } from '../src/github.js';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { pinsOf, readPins } from '../src/pins.js';
import { refKey } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { appendRegistryLine, readLiveSessions, readSession } from '../src/registry.js';
import { renderStatusLine } from '../src/render.js';
import { JsonV1Schema } from '../src/schemas/json-v1.js';
import { readSnapshot } from '../src/snapshot.js';
import { countStatuses, percentDone } from '../src/status.js';
import { readUsage, USAGE_FILE } from '../src/usage-ledger.js';
import { buildView } from '../src/view.js';
import { bash, SESSION } from './extract-helpers.js';
import { git, makeRepo, tempDir } from './repo-helpers.js';
import { demo, filesUnder } from './snapshot-helpers.js';

// Real GitHub, the public demo repository, the user's own token. Skipped
// unless EPIC_PULSE_LIVE=1 (`pnpm test:live`).
const live = { skip: process.env['EPIC_PULSE_LIVE'] !== '1' };

// The real environment with a private usage ledger, so a test run neither
// charges the user's own ledger nor waits on what it holds.
function liveEnv(t: TestContext): NodeJS.ProcessEnv {
  return { ...process.env, EPIC_PULSE_CACHE_DIR: tempDir(t) };
}

// A checkout of the demo repo in which a session tracked #8 and then
// commented on #4, recorded through the real hook path: payload, extract,
// registry. The comment is the later call, so epic #1 leads the status line.
async function demoSession(t: TestContext): Promise<RegistryPaths> {
  const root = makeRepo(t).root;
  git(root, ['remote', 'add', 'origin', 'https://github.com/takauztovies/epic-pulse.git']);
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  for (const [command, ts] of [['epic-pulse track 8', now - 1000], ['gh issue comment 4 --body "progress"', now]] as const) {
    const { ev, binds, unbinds } = await extract(bash(command, root));
    assert.equal(binds.length, 1, command);
    assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts, ev, binds, unbinds })).ok);
  }
  return paths;
}

// What the status line command does on every render: read the cached snapshot
// and the registry, build the session's view, render one line.
async function renderOnce(paths: RegistryPaths): Promise<string> {
  const now = Date.now();
  const [snapshot, session, sessions, pins] = await Promise.all([
    readSnapshot(paths.snapshotFile), readSession(paths, SESSION), readLiveSessions(paths, now), readPins(paths),
  ]);
  const view = JsonV1Schema.parse(buildView({ snapshot, sessions, pins: pinsOf(pins), now, scope: { session } }));
  return renderStatusLine(view, { width: 120 });
}

test('live: a full refresh of the demo epics matches GitHub, then serves from cache', live, async (t) => {
  const paths = await demoSession(t);
  const env = liveEnv(t);
  const first = await refresh({ dir: paths.dir, now: Date.now(), env });
  assert.ok(first.status === 'done' && first.error === null && first.points > 0);
  const charged = (await readUsage(join(env['EPIC_PULSE_CACHE_DIR']!, USAGE_FILE))).reduce((sum, line) => sum + line.points, 0);
  assert.ok(charged >= first.points, `ledger ${charged} points, GitHub billed ${first.points}`);
  t.diagnostic(`full refresh: ${JSON.stringify(first)}, ledger ${charged}`);
  const read = await readSnapshot(paths.snapshotFile);
  assert.ok(read.status === 'ok');
  const epic = read.snapshot.epics[refKey(demo(1))]!;
  assert.deepEqual(countStatuses(epic.children), { todo: 3, in_progress: 1, in_review: 0, done: 1, dropped: 1 });
  assert.equal(percentDone(countStatuses(epic.children)), 20);
  const checklist = countStatuses(read.snapshot.epics[refKey(demo(8))]!.children);
  assert.deepEqual([checklist.done, checklist.done + checklist.todo, checklist.dropped], [2, 4, 1]);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now() + 1000, env }), { status: 'done', requests: 0, points: 0, error: null });
});

test('live: the status line renders the demo epic from the cached snapshot, p95 under 100 ms', live, async (t) => {
  const paths = await demoSession(t);
  assert.equal((await refresh({ dir: paths.dir, now: Date.now(), env: liveEnv(t) })).status, 'done');
  const times: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now();
    const line = await renderOnce(paths);
    times.push(performance.now() - started);
    assert.equal(line, '#1 ▓▓░░░░░░░░ 20% 1/5 · wip 1 (+1)');
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
  t.diagnostic(`20 renders in-process: p50 ${sorted[9]!.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${sorted[19]!.toFixed(2)} ms`);
  assert.ok(p95 < 100, `p95 ${p95} ms`);
});

test('live: the real token is on no file after a real refresh', live, async (t) => {
  const paths = await demoSession(t);
  const token = (await resolveToken('github.com', process.env))?.token;
  assert.ok(token && token.length > 10, 'a token is available for the live run');
  const env = liveEnv(t);
  assert.equal((await refresh({ dir: paths.dir, now: Date.now(), env })).status, 'done');
  const files = [...filesUnder(paths.dir), ...filesUnder(env['EPIC_PULSE_CACHE_DIR']!)];
  assert.ok(files.includes(paths.snapshotFile));
  for (const file of files) assert.equal(readFileSync(file, 'utf8').includes(token), false, file);
});
