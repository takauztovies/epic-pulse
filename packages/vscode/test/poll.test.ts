import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendRegistryLine, pathsFor, STALE_AFTER_MS } from '@epic-pulse/core';
import { pollAll, readAll } from '../src/poll.js';
import { demo, demoSnapshot, filesUnder, makeRegistry, noGhEnv, SESSION_A, SESSION_B, tempDir } from './registry-helpers.js';

test('a repository whose registry does not exist is read but never refreshed, so nothing is created', async (t) => {
  const repo = { dir: join(tempDir(t), '.git', 'epic-pulse'), folder: tempDir(t), label: 'untouched' };
  const [result] = await pollAll([repo], { now: Date.now(), env: noGhEnv(t), grant: { 'github.com': 'gho_unused' } });
  assert.deepEqual([result?.refresh, result?.token, result?.hookSeen], [{ status: 'skipped' }, 'none', false]);
  assert.equal(existsSync(join(repo.dir, '..')), false, 'the poll created the registry or its parent');
});

test('a registry that exists is refreshed and read back, one result per repository in order', async (t) => {
  const now = Date.now();
  const fresh = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const missing = { dir: join(tempDir(t), 'epic-pulse'), folder: tempDir(t), label: 'missing' };
  const results = await pollAll([fresh, missing], { now, env: noGhEnv(t), grant: {} });
  // A fresh snapshot needs no request, so the refresh is done without a token.
  assert.deepEqual(results.map((result) => [result.repo.label, result.refresh.status, result.view.snapshot.state]), [
    ['demo', 'done', 'ok'],
    ['missing', 'skipped', 'none'],
  ]);
});

// What an unfocused window does on each tick. Every file's size and time, so a
// read that wrote, touched or created anything shows.
function fingerprint(dir: string): readonly string[] {
  return filesUnder(dir).map((file) => `${file} ${statSync(file).size} ${statSync(file).mtimeMs}`);
}

test('reading again redraws from the files alone: what aged is stale, what another process wrote shows, the last refresh is carried over', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const polled = await pollAll([repo], { now, env: noGhEnv(t), grant: {} });
  assert.deepEqual([polled[0]?.view.snapshot.state, polled[0]?.view.liveSessions, polled[0]?.refresh.status], ['ok', 1, 'done']);
  // Another process: a second session starts in the repository.
  assert.ok((await appendRegistryLine(pathsFor(repo.dir), SESSION_B, { v: 1, ts: now, ev: 'start', binds: [] })).ok);
  const before = fingerprint(repo.dir);
  const again = await readAll(polled, now + STALE_AFTER_MS + 60_000);
  assert.deepEqual([again[0]?.view.snapshot.state, again[0]?.view.liveSessions], ['stale', 2]);
  assert.deepEqual([again[0]?.repo, again[0]?.refresh, again[0]?.token, again[0]?.hosts], [repo, polled[0]?.refresh, polled[0]?.token, polled[0]?.hosts]);
  assert.deepEqual(fingerprint(repo.dir), before, 'a read wrote, touched or created a file');
  assert.equal(existsSync(join(repo.dir, 'refresh.lock')), false);
});

test('reading again keeps every repository it was given, in order, and a registry that appeared since is read as it is now', async (t) => {
  const now = Date.now();
  const missing = { dir: join(tempDir(t), 'epic-pulse'), folder: tempDir(t), label: 'missing' };
  const known = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const polled = await pollAll([missing, known], { now, env: noGhEnv(t), grant: {} });
  assert.deepEqual(polled.map((result) => [result.repo.label, result.refresh.status, result.view.liveSessions]), [['missing', 'skipped', 0], ['demo', 'done', 1]]);
  assert.ok((await appendRegistryLine(pathsFor(missing.dir), SESSION_B, { v: 1, ts: now, ev: 'start', binds: [] })).ok);
  const again = await readAll(polled, now + 1000);
  assert.deepEqual(again.map((result) => [result.repo.label, result.refresh.status, result.view.liveSessions, result.hookSeen]), [['missing', 'skipped', 1, true], ['demo', 'done', 1, true]]);
  assert.deepEqual(await readAll([], now), []);
});
