import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pollAll } from '../src/poll.js';
import { demo, demoSnapshot, makeRegistry, noGhEnv, SESSION_A, tempDir } from './registry-helpers.js';

test('a repository whose registry does not exist is read but never refreshed, so nothing is created', async (t) => {
  const repo = { dir: join(tempDir(t), '.git', 'epic-pulse'), label: 'untouched' };
  const [result] = await pollAll([repo], { now: Date.now(), env: noGhEnv(t), grant: { github: 'gho_unused' } });
  assert.deepEqual([result?.refresh, result?.token, result?.hookSeen], [{ status: 'skipped' }, 'none', false]);
  assert.equal(existsSync(join(repo.dir, '..')), false, 'the poll created the registry or its parent');
});

test('a registry that exists is refreshed and read back, one result per repository in order', async (t) => {
  const now = Date.now();
  const fresh = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot: demoSnapshot(now - 1000) }, now);
  const missing = { dir: join(tempDir(t), 'epic-pulse'), label: 'missing' };
  const results = await pollAll([fresh, missing], { now, env: noGhEnv(t), grant: {} });
  // A fresh snapshot needs no request, so the refresh is done without a token.
  assert.deepEqual(results.map((result) => [result.repo.label, result.refresh.status, result.view.snapshot.state]), [
    ['demo', 'done', 'ok'],
    ['missing', 'skipped', 'none'],
  ]);
});
