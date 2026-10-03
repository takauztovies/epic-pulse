import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { git, ROOT, tempDir } from './helpers.js';

// The self-test word, spelled in two pieces so that this file, which the check
// reads too, does not hold it. The digest is what the recipe in the list's
// header prints for it under KEY, run once by hand:
//   printf %s zqxplorvantumbek | openssl dgst -sha256 -hmac a-key-for-tests-only
// so a digest on which the script and that recipe disagree can not hide.
export const WORD = ['zqxplor', 'vantumbek'].join('');
export const KEY = 'a-key-for-tests-only';
export const DIGEST = 'ad69026f9b95983a0ed9fb768f8d035ed58b21fd1e5993c3776d7bca487f08e3';
export const LIST = `# a test list\n\n${DIGEST}\n`;

export const SCRIPT = join(ROOT, 'scripts', 'check-denylist.mjs');

// Nothing of the machine's own may decide a result: not a CI run's GITHUB_*
// variables, not a real key in the environment or in the home directory.
const SCRUBBED = /^(?:GIT_|GITHUB_|EPIC_PULSE_|HEAD_REPO$|CI$)/;

export interface Run {
  readonly status: number | null;
  readonly out: string;
}

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  // The home directory the script finds its key file in; an empty one by default.
  readonly home?: string;
}

export function run(t: TestContext, repo: string, options: RunOptions = {}): Run {
  const home = options.home ?? tempDir(t, 'ep-home-');
  const kept = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUBBED.test(key)));
  const env = { ...kept, HOME: home, USERPROFILE: home, ...options.env };
  const result = spawnSync(process.execPath, [join(repo, 'scripts', 'check-denylist.mjs')], { cwd: repo, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

// A home directory holding the key file, with exactly this content.
export function homeWithKey(t: TestContext, content: string): string {
  const home = tempDir(t, 'ep-home-');
  mkdirSync(join(home, '.config', 'epic-pulse'), { recursive: true });
  writeFileSync(join(home, '.config', 'epic-pulse', 'denylist.key'), content);
  return home;
}

// A throwaway repository in which these files are tracked, in its index, with
// its own copy of the script and its own list. Both are copied after the add,
// so they are untracked and the check does not read them.
export function repoWith(t: TestContext, files: Readonly<Record<string, string>>, list = LIST): string {
  const dir = tempDir(t);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ['add', '--', ...Object.keys(files)]);
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check-denylist.mjs'));
  writeFileSync(join(dir, 'scripts', 'denylist.hmac'), list);
  return dir;
}
