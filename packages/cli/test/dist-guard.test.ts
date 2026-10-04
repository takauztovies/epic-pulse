import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, GIT_CONFIG } from './helpers.js';
import { releaseRepo } from './release-helpers.js';

// scripts/check-dist-guard.mjs, the plugin/dist guard CI runs on every pull
// request, run for real in throwaway repositories: real commits, real
// branches and, on release branches, the real build it is checked against.

const REPO = 'takauztovies/epic-pulse';

interface Pull {
  readonly ref: string;
  readonly from?: string;
}

function guard(repo: string, pull: Pull): { readonly status: number | null; readonly stdout: string } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'GITHUB_REPOSITORY'));
  const shas = { BASE_SHA: git(repo, ['rev-parse', 'main']).trim(), HEAD_SHA: git(repo, ['rev-parse', 'HEAD']).trim() };
  const env = { ...clean, ...shas, HEAD_REF: pull.ref, HEAD_REPO: pull.from ?? REPO, GITHUB_REPOSITORY: REPO, GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
  const run = spawnSync(process.execPath, [join(repo, 'scripts', 'check-dist-guard.mjs')], { cwd: repo, env, encoding: 'utf8' });
  return { status: run.status, stdout: `${run.stdout}${run.stderr}` };
}

function build(repo: string): void {
  const run = spawnSync(process.execPath, [join(repo, 'scripts', 'build.mjs')], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

interface Change {
  readonly name: string;
  readonly write: () => void;
  // What the commit adds; plugin/dist goes in even though it is ignored.
  readonly paths?: readonly string[];
}

// A branch off main whose one commit adds whatever `write` wrote.
function branch(repo: string, change: Change): void {
  git(repo, ['switch', '-q', '-c', change.name]);
  change.write();
  git(repo, ['add', '--force', '--', ...(change.paths ?? ['.'])]);
  git(repo, ['commit', '-q', '-m', `change on ${change.name}`]);
}

test('a pull request that leaves plugin/dist alone passes', (t) => {
  const repo = releaseRepo(t);
  branch(repo, { name: 'fix/42-readme', write: () => appendFileSync(join(repo, 'README.md'), '\nmore\n') });
  assert.deepEqual(guard(repo, { ref: 'fix/42-readme' }), { status: 0, stdout: 'plugin/dist is unchanged.\n' });
});

test('plugin/dist changed on a branch that is not a release branch of this repository fails', (t) => {
  const repo = releaseRepo(t);
  branch(repo, { name: 'feat/release/7-sneaky', write: () => {
    mkdirSync(join(repo, 'plugin', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'plugin', 'dist', 'epic-pulse.mjs'), 'console.log("not the build");\n');
  } });
  for (const pull of [{ ref: 'feat/release/7-sneaky' }, { ref: 'release/v9.9.9', from: 'someone/epic-pulse' }]) {
    const run = guard(repo, pull);
    assert.equal(run.status, 1, JSON.stringify(pull));
    assert.match(run.stdout, /^::error::plugin\/dist is release-owned: only a release\/\* branch of takauztovies\/epic-pulse may change it/m);
    assert.match(run.stdout, /^plugin\/dist\/epic-pulse\.mjs$/m);
  }
});

test('a release branch that commits exactly what its sources build passes', (t) => {
  const repo = releaseRepo(t);
  branch(repo, { name: 'release/v9.9.9', write: () => build(repo), paths: ['plugin/dist'] });
  build(repo);
  const run = guard(repo, { ref: 'release/v9.9.9' });
  assert.deepEqual([run.status, run.stdout.split('\n')], [0, [
    'plugin/dist changes on release/v9.9.9, a release branch of this repository.',
    'plugin/dist on release/v9.9.9 is exactly what its sources build.', '',
  ]]);
});

test('a release branch whose plugin/dist is not what its sources build fails', (t) => {
  const stale = releaseRepo(t);
  branch(stale, { name: 'release/v9.9.9', paths: ['plugin/dist'], write: () => {
    build(stale);
    appendFileSync(join(stale, 'plugin', 'dist', 'epic-pulse.mjs'), '// edited by hand\n');
  } });
  build(stale);
  const edited = guard(stale, { ref: 'release/v9.9.9' });
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /^::error::.*not what its sources build[^\n]*\nplugin\/dist\/epic-pulse\.mjs$/m);
  const partial = releaseRepo(t);
  branch(partial, { name: 'release/v9.9.9', write: () => build(partial), paths: ['plugin/dist/epic-pulse.mjs'] });
  build(partial);
  const run = guard(partial, { ref: 'release/v9.9.9' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error::.*not what its sources build[^\n]*\nplugin\/dist\/THIRD_PARTY_NOTICES\.md$/m);
});

test('a release branch that does not commit the plugin bundle at all fails', (t) => {
  const repo = releaseRepo(t);
  branch(repo, { name: 'release/v9.9.9', write: () => appendFileSync(join(repo, 'README.md'), '\nmore\n') });
  build(repo);
  const run = guard(repo, { ref: 'release/v9.9.9' });
  assert.deepEqual([run.status, run.stdout], [1, 'plugin/dist is unchanged.\n::error::plugin/dist/epic-pulse.mjs is not committed on release/v9.9.9.\n']);
});
