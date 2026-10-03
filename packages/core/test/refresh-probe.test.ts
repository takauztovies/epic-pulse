import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { addPin } from '../src/pins.js';
import { refKey } from '../src/ref.js';
import { REFRESH_SESSION_ENV, refresh } from '../src/refresh.js';
import { EPIC_TTL_MS } from '../src/refresh-plan.js';
import { appendRegistryLine } from '../src/registry.js';
import type { BindVia, IssueRef } from '../src/schemas/common.js';
import { emptySnapshot, writeSnapshot } from '../src/snapshot.js';
import { cachedEpic, invalid, SESSION, sendingEnv, writeLedger } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';

// A pin names its issue, and an issue with a parent resolves to that parent, so
// the refresher also asks whether a pinned child is an epic itself (probeTargets).
// Real refreshes of real temp registries: the `.invalid` host never resolves,
// so each admitted request really goes out and really fails as `network`.

const CHILD = invalid(4);
const PARENT = invalid(1);
const MINUTE = 60_000;
const ASKED = { status: 'done', requests: 1, points: 0, error: 'network' };
const NOT_ASKED = { status: 'done', requests: 0, points: 0, error: null };

interface Known {
  // What Phase B found about the child itself: absent, not an epic, or an epic
  // whose entry was fetched at this time.
  readonly isEpic?: boolean;
  readonly entryFetchedAt?: number;
}

// #4, a child of epic #1, resolved a minute ago, and #1 fetched a minute ago:
// nothing is due but, for a pin, whether #4 is an epic itself.
async function resolved(t: TestContext, now: number, known: Known = {}): Promise<RegistryPaths> {
  const paths = pathsFor(tempDir(t));
  const resolution = { epic: PARENT, resolvedAt: now - MINUTE, ...(known.isEpic === undefined ? {} : { isEpic: known.isEpic }) };
  const own = known.entryFetchedAt === undefined ? {} : { [refKey(CHILD)]: cachedEpic(CHILD, known.entryFetchedAt) };
  const epics = { [refKey(PARENT)]: cachedEpic(PARENT, now - MINUTE), ...own };
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), issues: { [refKey(CHILD)]: resolution }, epics });
  return paths;
}

async function bindVia(paths: RegistryPaths, binding: { readonly ref: IssueRef; readonly via: BindVia }, now: number): Promise<void> {
  assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: now, ev: 'tool', binds: [binding] })).ok);
}

async function run(t: TestContext, paths: RegistryPaths, now: number): Promise<{ readonly outcome: unknown; readonly charged: readonly number[] }> {
  const cache = tempDir(t);
  const outcome = await refresh({ dir: paths.dir, now, env: sendingEnv(t, cache) });
  const lines = (() => {
    try {
      return readFileSync(join(cache, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  })();
  return { outcome, charged: lines.map((raw) => (JSON.parse(raw) as { points: number }).points) };
}

test('a pinned child of an epic is asked about as an epic of its own: one epic, 3 points, for a session pin and a repository pin alike', async (t) => {
  const now = Date.now();
  const bySession = await resolved(t, now);
  await bindVia(bySession, { ref: CHILD, via: 'pin' }, now);
  assert.deepEqual(await run(t, bySession, now), { outcome: ASKED, charged: [3] });
  const byRepository = await resolved(t, now);
  assert.ok((await addPin(byRepository, CHILD, now)).ok);
  assert.deepEqual(await run(t, byRepository, now), { outcome: ASKED, charged: [3] });
});

test('work bound to the child, and a pin already found not to be an epic, ask nothing', async (t) => {
  const now = Date.now();
  const work = await resolved(t, now);
  await bindVia(work, { ref: CHILD, via: 'gh' }, now);
  assert.deepEqual(await run(t, work, now), { outcome: NOT_ASKED, charged: [] });
  const found = await resolved(t, now, { isEpic: false });
  await bindVia(found, { ref: CHILD, via: 'pin' }, now);
  assert.deepEqual(await run(t, found, now), { outcome: NOT_ASKED, charged: [] });
  const repositoryPin = await resolved(t, now, { isEpic: false });
  assert.ok((await addPin(repositoryPin, CHILD, now)).ok);
  assert.deepEqual(await run(t, repositoryPin, now), { outcome: NOT_ASKED, charged: [] });
});

test('a pin found to be an epic is kept current by the epic cache, two minutes, and not asked again before', async (t) => {
  const now = Date.now();
  const fresh = await resolved(t, now, { isEpic: true, entryFetchedAt: now - MINUTE });
  await bindVia(fresh, { ref: CHILD, via: 'pin' }, now);
  assert.deepEqual(await run(t, fresh, now), { outcome: NOT_ASKED, charged: [] });
  const due = await resolved(t, now, { isEpic: true, entryFetchedAt: now - EPIC_TTL_MS - 1 });
  await bindVia(due, { ref: CHILD, via: 'pin' }, now);
  assert.deepEqual(await run(t, due, now), { outcome: ASKED, charged: [3] });
});

// The status line's own session counts however long it has been quiet, its pins
// among the rest: it hands its id over in EPIC_PULSE_SESSION.
test('a pin of the status line\'s own session, quiet for three hours, is asked about too', async (t) => {
  const now = Date.now();
  const paths = await resolved(t, now);
  await bindVia(paths, { ref: CHILD, via: 'pin' }, now - 3 * 60 * MINUTE);
  assert.deepEqual((await run(t, paths, now)).outcome, NOT_ASKED, 'a session that is not live is not gathered');
  const cache = tempDir(t);
  const env = { ...sendingEnv(t, cache), [REFRESH_SESSION_ENV]: SESSION };
  assert.deepEqual(await refresh({ dir: paths.dir, now, env }), ASKED);
});

// What a paced repository still asks is what nothing has shown yet. The pin
// shows its parent's epic meanwhile, so the question waits its turn, as any
// cached data does.
test('a paced repository leaves the question for its turn', async (t) => {
  const now = Date.now();
  const paths = await resolved(t, now);
  await bindVia(paths, { ref: CHILD, via: 'pin' }, now);
  const cache = tempDir(t);
  writeLedger(cache, [{ ts: now - 60_000, points: 3 }, { ts: now - 1000, points: 1, mine: paths.dir }]);
  const outcome = await refresh({ dir: paths.dir, now, env: sendingEnv(t, cache) });
  assert.deepEqual(outcome, { status: 'paced', until: now - 1000 + 24_000 });
});
