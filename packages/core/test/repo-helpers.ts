import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

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

// Real repositories, real `git`. The environment is scrubbed of every GIT_*
// variable (a git hook exports GIT_DIR, which would point these commands at the
// repository running the tests) and of the user's global config.
function gitEnv(): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...clean, HOME: tmpdir(), XDG_CONFIG_HOME: tmpdir(), GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
}

export function tempDir(t: TestContext, prefix = 'ep-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function git(cwd: string, args: readonly string[]): string {
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], { cwd, env: gitEnv(), encoding: 'utf8' });
}

export interface TestRepo {
  readonly root: string;
  readonly base: string;
}

// `<base>/main` is the repository; worktrees are added next to it.
export function makeRepo(t: TestContext, branch = 'main'): TestRepo {
  const base = tempDir(t);
  const root = join(base, 'main');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
  return { root, base };
}

export function addWorktree(repo: TestRepo, name: string, branch: string): string {
  const path = join(repo.base, name);
  git(repo.root, ['worktree', 'add', '-q', '-b', branch, path]);
  return path;
}
