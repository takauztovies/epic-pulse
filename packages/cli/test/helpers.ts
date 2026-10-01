import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathsFor, type RegistryPaths } from '@epic-pulse/core';

// Every CLI test runs the built bundle in a real process, the way Claude Code
// runs it. `pnpm test` builds it first.
export const BUNDLE = fileURLToPath(new URL('../dist/epic-pulse.mjs', import.meta.url));
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
export const DEMO_REMOTE = 'https://github.com/takauztovies/epic-pulse.git';

export function tempDir(t: TestContext, prefix = 'ep-cli-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface Sandbox {
  readonly home: string;
  readonly config: string;
  // An empty directory as the whole PATH: `gh` can not be found, so no real
  // token is ever read and nothing reaches the network.
  readonly bin: string;
}

export function sandbox(t: TestContext): Sandbox {
  const root = tempDir(t, 'ep-box-');
  const box = { home: join(root, 'home'), config: join(root, 'home', '.claude'), bin: join(root, 'bin') };
  mkdirSync(box.config, { recursive: true });
  mkdirSync(box.bin);
  return box;
}

// The real HOME, Claude config, tokens and git variables never reach a child:
// the host running these tests may itself be a Claude Code session.
const SCRUBBED = /^(?:GIT_|GH_|GITHUB_|CLAUDE|EPIC_PULSE_)/;

export function cliEnv(box: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUBBED.test(key)));
  return { ...kept, HOME: box.home, USERPROFILE: box.home, CLAUDE_CONFIG_DIR: box.config, PATH: box.bin, ...extra };
}

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly bundle?: string;
}

export function runCli(args: readonly string[], options: RunOptions): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [options.bundle ?? BUNDLE, ...args], { cwd: options.cwd, env: options.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => undefined); // a child may exit before it has read everything
    child.on('error', reject);
    child.on('close', (code) => {
      const ms = performance.now() - started;
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ms });
    });
    child.stdin.end(options.input ?? '');
  });
}

// Real repositories through real `git`, with every GIT_* variable and the
// user's global config kept out.
export function git(cwd: string, args: readonly string[]): string {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...clean, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  return execFileSync('git', [...identity, ...args], { cwd, env, encoding: 'utf8' });
}

// A checkout of the public demo repository's remote: `<base>/main`.
export function demoRepo(t: TestContext): string {
  const root = join(tempDir(t, 'ep-repo-'), 'main');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(root, ['remote', 'add', 'origin', DEMO_REMOTE]);
  return root;
}

export function registryOf(repo: string): RegistryPaths {
  return pathsFor(join(repo, '.git', 'epic-pulse'));
}

// Waits for a detached process's side effect, within a deadline.
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
