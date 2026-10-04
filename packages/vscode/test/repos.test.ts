import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { discoverRepos } from '../src/repos.js';
import { tempDir } from './registry-helpers.js';

// git's global config in tests: an empty file, not os.devNull. On Windows that
// is `\\.\nul`, which git refuses to open ("unable to access '\\.\nul':
// Invalid argument"), so every git command failed there. One file per test
// process, removed as the process exits.
function emptyGitConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ep-gitconfig-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config');
  writeFileSync(file, '');
  return file;
}

const GIT_CONFIG = emptyGitConfig();

// Real repositories and worktrees, real `git`, with every GIT_* variable and
// the user's global config scrubbed: a git hook exports GIT_DIR, which would
// point these commands at the repository running the tests.
function git(cwd: string, args: readonly string[]): void {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...clean, HOME: tmpdir(), XDG_CONFIG_HOME: tmpdir(), GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
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

// A folder reached through a link (on a Windows runner the short 8.3 spelling of
// the temp dir, on macOS /var for /private/var) is the same repository: its
// registry is listed once, not once per spelling.
test('a folder reached through a link is the same repository, listed once under the first name', async (t) => {
  const root = makeRepo(t, 'app');
  const shortcut = join(tempDir(t), 'shortcut');
  symlinkSync(root, shortcut, 'junction');
  assert.deepEqual(await discoverRepos([shortcut, root], {}), [{ dir: join(root, '.git', 'epic-pulse'), label: 'shortcut' }]);
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
