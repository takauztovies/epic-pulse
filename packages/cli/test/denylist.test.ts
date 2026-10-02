import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { git, ROOT, tempDir } from './helpers.js';

// scripts/check-denylist.mjs fails on any word whose SHA-256 digest is in
// scripts/denylist.sha256. The list holds the digest of one nonsense word for
// these tests, spelled here in two pieces so that this file, which the check
// reads too, does not hold it.
const WORD = ['zqxplor', 'vantumbek'].join('');
const SCRIPT = join(ROOT, 'scripts', 'check-denylist.mjs');

// Without the GIT_* variables a git hook exports, which would point the
// script's `git ls-files` at the repository running the tests.
function check(cwd: string, script = SCRIPT): { readonly status: number | null; readonly out: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const run = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

// A throwaway repository in which these files are tracked: in its index.
function repoWith(t: TestContext, files: Readonly<Record<string, string>>): string {
  const dir = tempDir(t);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, ['add', '--', ...Object.keys(files)]);
  return dir;
}

test('the repository, its fixtures and its built bundles hold no denylisted word', () => {
  const run = check(ROOT);
  assert.equal(run.status, 0, run.out);
  const files = Number(/no denylisted word in (\d+) files/.exec(run.out)?.[1] ?? 0);
  assert.ok(files > 150, `only ${files} files were read, so the check looked at too little`);
});

test('a listed word in a tracked file, in any case, fails the check, which names the place and not the word', (t) => {
  const run = check(repoWith(t, { 'notes/plan.md': `line one\nWe met the ${WORD.toUpperCase()}-team.\n` }));
  assert.equal(run.status, 1, run.out);
  assert.equal(run.out, 'epic-pulse: notes/plan.md:2 holds a denylisted word (sha256 5409dfdc8f2c...)\n');
  assert.equal(run.out.toLowerCase().includes(WORD), false, 'the check printed the word it hides');
});

test('a listed word in what a build wrote fails it too, though dist is not tracked', (t) => {
  const repo = repoWith(t, { 'README.md': 'clean\n' });
  mkdirSync(join(repo, 'plugin', 'dist'), { recursive: true });
  writeFileSync(join(repo, 'plugin', 'dist', 'epic-pulse.mjs'), `const x = "${WORD}";\n`);
  assert.deepEqual(check(repo), { status: 1, out: 'epic-pulse: plugin/dist/epic-pulse.mjs:1 holds a denylisted word (sha256 5409dfdc8f2c...)\n' });
});

// A digest one character short would never match anything.
test('a denylist line that is not a digest is refused rather than skipped', (t) => {
  const repo = repoWith(t, { 'README.md': 'clean\n' });
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(SCRIPT, join(repo, 'scripts', 'check-denylist.mjs'));
  writeFileSync(join(repo, 'scripts', 'denylist.sha256'), '# a comment\n\n5409dfdc8f2c9b71c34c0085e168cd5978642573a36251e39bc3c1ab2123af7\n');
  assert.deepEqual(check(repo, join(repo, 'scripts', 'check-denylist.mjs')), { status: 2, out: 'epic-pulse: scripts/denylist.sha256 line 3: not a SHA-256 hex digest\n' });
});
