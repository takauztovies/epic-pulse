import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { discoverRepos } from '../src/repos.js';
import { tempDir } from './registry-helpers.js';

// Real repositories and worktrees, real `git`, with every GIT_* variable and
// the user's global config scrubbed: a git hook exports GIT_DIR, which would
// point these commands at the repository running the tests.
function git(cwd: string, args: readonly string[]): void {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...clean, HOME: tmpdir(), XDG_CONFIG_HOME: tmpdir(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  execFileSync('git', [...identity, ...args], { cwd, env, stdio: 'ignore' });
}

function makeRepo(t: TestContext, name: string): string {
  const root = join(tempDir(t), name);
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return root;
}

test('the folders of one repository, its worktrees included, lead to one registry under the first name', async (t) => {
  const root = makeRepo(t, 'app');
  const worktree = join(root, '..', 'app-feature');
  git(root, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
  const nested = join(root, 'packages');
  mkdirSync(nested);
  const repos = await discoverRepos([worktree, root, nested], {});
  assert.deepEqual(repos, [{ dir: join(root, '.git', 'epic-pulse'), label: 'app-feature' }]);
});

test('separate repositories each get their registry, in folder order, and folders outside git none', async (t) => {
  const first = makeRepo(t, 'first');
  const second = makeRepo(t, 'second');
  const plain = tempDir(t);
  const repos = await discoverRepos([second, plain, first], {});
  assert.deepEqual(repos.map((repo) => repo.label), ['second', 'first']);
  assert.deepEqual(repos.map((repo) => repo.dir), [join(second, '.git', 'epic-pulse'), join(first, '.git', 'epic-pulse')]);
  assert.deepEqual(await discoverRepos([], {}), []);
});
