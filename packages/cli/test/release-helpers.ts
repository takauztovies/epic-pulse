import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { git, GIT_CONFIG, ROOT, tempDir } from './helpers.js';

export const RELEASE_MANIFESTS = ['packages/cli/package.json', 'plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const VSCODE_MANIFEST = 'packages/vscode/package.json';

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// The script commits, so it needs an identity, and none of the user's own
// config: no signing prompt, no global hook.
function releaseEnv(): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  return { ...clean, ...identity, GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
}

export function release(repo: string, args: readonly string[]): Run {
  const run = spawnSync(process.execPath, [join(repo, 'scripts', 'release.mjs'), ...args], { cwd: repo, env: releaseEnv(), encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

// Installed dependencies are linked, not copied: junctions on Windows,
// symlinks elsewhere. Git sees a link as a file, which `node_modules/` in
// .gitignore does not match, so the clone's own exclude file names it.
function linkDependencies(dir: string): void {
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules\n');
  const packages = readdirSync(join(ROOT, 'packages')).map((name) => join('packages', name));
  for (const sub of ['', ...packages]) {
    const target = join(ROOT, sub, 'node_modules');
    if (existsSync(target) && existsSync(join(dir, sub))) symlinkSync(target, join(dir, sub, 'node_modules'), 'junction');
  }
}

// This checkout's files, committed or not, minus whatever git ignores, as the
// first commit of a repository of their own on `main`. The script runs there
// for real; this repository's branches and tags are never touched.
// plugin/dist is the one tracked file set that differs by where the tests run:
// a release branch, and main after a release, track it; a feature branch does
// not. The throwaway main is the sources only, so every test starts from the
// same base wherever it runs.
const RELEASE_BUILT = 'plugin/dist/';

export function releaseRepo(t: TestContext): string {
  const dir = tempDir(t, 'ep-release-');
  const listed = git(ROOT, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const sources = listed.filter((name) => !name.startsWith(RELEASE_BUILT) && existsSync(join(ROOT, name)));
  for (const file of sources) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(dir, file));
  }
  git(dir, ['init', '-q', '-b', 'main']);
  linkDependencies(dir);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

export function manifestsIn(repo: string): readonly string[] {
  return existsSync(join(repo, VSCODE_MANIFEST)) ? [...RELEASE_MANIFESTS, VSCODE_MANIFEST] : RELEASE_MANIFESTS;
}

export function cliVersion(repo: string): string {
  return z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(repo, RELEASE_MANIFESTS[0]!), 'utf8'))).version;
}

// The next minor version after the CLI's, so the tests keep working after
// every real release.
export function nextMinor(repo: string): string {
  const [major, minor] = cliVersion(repo).split('.').map(Number);
  return `${major ?? 0}.${(minor ?? 0) + 1}.0`;
}

// What a run leaves behind: commit, branches, tags and the working tree.
export function repoState(repo: string): readonly string[] {
  return [['rev-parse', 'HEAD'], ['branch', '--list'], ['tag', '--list'], ['status', '--porcelain', '--untracked-files=all']].map((args) => git(repo, args));
}

export function assertRefused(run: Run, code: number, reason: RegExp): void {
  assert.equal(run.status, code, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, reason);
}
