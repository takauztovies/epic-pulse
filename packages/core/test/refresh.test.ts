import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { acquireLock, releaseLock } from '../src/lock.js';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { addPin } from '../src/pins.js';
import { makeRef } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { appendRegistryLine } from '../src/registry.js';
import type { IssueRef } from '../src/schemas/common.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot, filesUnder, noGhEnv } from './snapshot-helpers.js';

const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const SENTINEL = 'SENTINEL-7f3a-never-persist';

async function boundRegistry(t: TestContext, refs: readonly IssueRef[]): Promise<RegistryPaths> {
  const paths = pathsFor(tempDir(t));
  const binds = refs.map((ref) => ({ ref, via: 'gh' as const }));
  assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: Date.now(), ev: 'tool', binds })).ok);
  return paths;
}

async function snapshotError(paths: RegistryPaths): Promise<unknown> {
  const read = await readSnapshot(paths.snapshotFile);
  return read.status === 'ok' ? read.snapshot.error : read.status;
}

test('a second refresher finds the lock held and leaves without touching anything', async (t) => {
  const paths = await boundRegistry(t, [demo(4)]);
  const held = await acquireLock(paths.lockFile, { now: Date.now(), staleMs: 60_000 });
  assert.ok(held);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: {} }), { status: 'busy' });
  assert.equal(existsSync(paths.snapshotFile), false);
  await releaseLock(held);
});

test('with nothing bound or pinned a refresh makes no request, writes nothing and releases the lock', async (t) => {
  const paths = pathsFor(tempDir(t));
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: {} }), { status: 'done', requests: 0, points: 0, error: null });
  assert.equal(existsSync(paths.snapshotFile), false);
  assert.equal(existsSync(paths.lockFile), false);
});

test('a spent hourly budget makes no request and is recorded as budget', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), usage: { windowStart: now - 60_000, points: 300 } });
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'budget' });
  assert.equal(await snapshotError(paths), 'budget');
});

test('an hour later the budget is available again', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), usage: { windowStart: now - 2 * 3_600_000, points: 300 } });
  // Past the budget check, the next gate is the token, which this env lacks.
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'no_token' });
});

test('a low rate limit backs off until its reset, then lets requests through', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  await writeSnapshot(paths.snapshotFile, { ...emptySnapshot(now), rateLimit: { remaining: 999, resetAt: now + 60_000 } });
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: 'budget' });
  assert.equal(await snapshotError(paths), 'budget');
  const later = await refresh({ dir: paths.dir, now: now + 61_000, env: noGhEnv(t) });
  assert.deepEqual(later, { status: 'done', requests: 0, points: 0, error: 'no_token' });
});

test('a fresh snapshot makes no request and is not rewritten', async (t) => {
  const now = Date.now();
  const paths = await boundRegistry(t, [demo(4)]);
  assert.ok((await addPin(paths, demo(8), now)).ok);
  await writeSnapshot(paths.snapshotFile, demoSnapshot(now - 1000));
  const before = readFileSync(paths.snapshotFile);
  assert.deepEqual(await refresh({ dir: paths.dir, now, env: noGhEnv(t) }), { status: 'done', requests: 0, points: 0, error: null });
  assert.deepEqual(readFileSync(paths.snapshotFile), before);
});

// No server is involved: `.invalid` never resolves (RFC 6761), so the token is
// really sent through fetch and really fails, and undici builds its errors
// from what it was given. A NUL makes the header itself invalid, which is the
// path where undici echoes the header value, token included, in its message.
test('a token never reaches any file the refresher writes, whatever the failure', async (t) => {
  const cases = [[SENTINEL, 'network'], [`${SENTINEL}\u0000x`, 'invalid_token']] as const;
  for (const [token, code] of cases) {
    const paths = await boundRegistry(t, [makeRef({ host: 'epic-pulse.invalid', owner: 'acme', repo: 'widgets', number: 4 })!]);
    const outcome = await refresh({ dir: paths.dir, now: Date.now(), env: noGhEnv(t, { GH_ENTERPRISE_TOKEN: token }) });
    assert.deepEqual(outcome, { status: 'done', requests: 1, points: 0, error: code });
    const files = filesUnder(paths.dir);
    assert.ok(files.some((file) => file === paths.snapshotFile), 'the failure was written to disk');
    for (const file of files) assert.equal(readFileSync(file, 'utf8').includes('SENTINEL'), false, file);
  }
});
