import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from './helpers.js';
import { assertRefused, cliVersion, manifestsIn, nextMinor, release, releaseRepo, repoState } from './release-helpers.js';

// scripts/release.mjs, run for real in a throwaway repository.

const PLUGIN_BUNDLE = 'plugin/dist/epic-pulse.mjs';
const PLUGIN_NOTICES = 'plugin/dist/THIRD_PARTY_NOTICES.md';

function blob(repo: string, spec: string): string {
  return git(repo, ['rev-parse', spec]).trim();
}

function fileBlob(repo: string, path: string): string {
  return git(repo, ['hash-object', '--no-filters', path]).trim();
}

function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

test('a release bumps only the version of every manifest and commits them with the rebuilt plugin bundle', (t) => {
  const repo = releaseRepo(t);
  const next = nextMinor(repo);
  const before = new Map(manifestsIn(repo).map((path) => [path, readFileSync(join(repo, path), 'utf8')]));
  const run = release(repo, [next]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), `release/v${next}`);
  assert.equal(git(repo, ['log', '-1', '--format=%s']).trim(), `chore: release v${next}`);
  const committed = git(repo, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
  assert.deepEqual(committed, [...before.keys(), PLUGIN_BUNDLE, PLUGIN_NOTICES].sort());
  for (const [path, text] of before) {
    assert.equal(readFileSync(join(repo, path), 'utf8'), text.replace(/"version": "[^"]*"/, `"version": "${next}"`), path);
  }
  assert.equal(blob(repo, `HEAD:${PLUGIN_BUNDLE}`), fileBlob(repo, 'packages/cli/dist/epic-pulse.mjs'));
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.ok(run.stdout.includes(`git push -u origin release/v${next}\n`), run.stdout);
  assert.ok(run.stdout.includes(`git tag -a v${next} -m v${next} && git push origin v${next}\n`), run.stdout);
});

test('--check passes only while every manifest carries the version, with or without the v', (t) => {
  const repo = releaseRepo(t);
  const current = cliVersion(repo);
  for (const spelled of [current, `v${current}`]) assert.equal(release(repo, ['--check', spelled]).status, 0, spelled);
  assertRefused(release(repo, ['--check', nextMinor(repo)]), 1, /packages\/cli\/package\.json says /);
  const plugin = join(repo, 'plugin', '.claude-plugin', 'plugin.json');
  writeFileSync(plugin, readFileSync(plugin, 'utf8').replace(`"version": "${current}"`, '"version": "9.9.9"'));
  assertRefused(release(repo, ['--check', current]), 1, /^epic-pulse: plugin\/\.claude-plugin\/plugin\.json says 9\.9\.9, not /);
});

test('anything but a plain major.minor.patch is a usage error that changes nothing', (t) => {
  const repo = releaseRepo(t);
  const clean = repoState(repo);
  for (const args of [[], ['1.2'], ['1.2.3.4'], ['01.2.3'], ['1.2.3-rc.1'], ['latest'], ['1.2.3', 'extra'], ['--check']]) {
    assertRefused(release(repo, args), 2, /^usage: node scripts\/release\.mjs/);
  }
  assert.deepEqual(repoState(repo), clean);
});

test('a version that is not newer than every manifest is refused', (t) => {
  const repo = releaseRepo(t);
  const clean = repoState(repo);
  assertRefused(release(repo, [cliVersion(repo)]), 1, /is not newer than packages\/cli\/package\.json/);
  assertRefused(release(repo, ['0.0.1']), 1, /is not newer than /);
  assert.deepEqual(repoState(repo), clean);
});

test('uncommitted work, an existing branch or tag, or a branch other than main is refused, changing nothing', (t) => {
  const repo = releaseRepo(t);
  const next = nextMinor(repo);
  const clean = repoState(repo);
  writeFileSync(join(repo, 'stray.txt'), 'not committed');
  assertRefused(release(repo, [next]), 1, /commit or stash these first:\n\?\? stray\.txt/);
  git(repo, ['clean', '-q', '-f', '--', 'stray.txt']);
  const steps: readonly (readonly [readonly string[], RegExp, readonly string[]])[] = [
    [['branch', `release/v${next}`], new RegExp(literal(`the branch release/v${next} already exists`)), ['branch', '-D', `release/v${next}`]],
    [['tag', `v${next}`], new RegExp(literal(`the tag v${next} already exists`)), ['tag', '-d', `v${next}`]],
    [['switch', '-q', '-c', 'feature'], /releases are cut from main, and this is feature/, ['switch', '-q', 'main']],
  ];
  for (const [setup, reason, undo] of steps) {
    git(repo, setup);
    assertRefused(release(repo, [next]), 1, reason);
    git(repo, undo);
  }
  git(repo, ['branch', '-q', '-D', 'feature']);
  assert.deepEqual(repoState(repo), clean);
});

// A hand-edited manifest can grow a second "version" or rename the plugin
// entry; the script refuses rather than bump the wrong field.
test('a manifest with a second version field, or none where its version is read, is refused before anything changes', (t) => {
  const repo = releaseRepo(t);
  const marketplace = join(repo, '.claude-plugin', 'marketplace.json');
  const original = readFileSync(marketplace, 'utf8');
  // A Windows checkout may have turned the line ends into CRLF.
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const variants: readonly (readonly [string, RegExp])[] = [
    [original.replace('"metadata": {', `"metadata": {${eol}    "version": "1.0.0",`), /marketplace\.json has 2 "version" fields, expected exactly one/],
    [original.replace(`"name": "epic-pulse",${eol}      "source"`, `"name": "renamed",${eol}      "source"`), /marketplace\.json: the "version" field is not where its version is read/],
  ];
  for (const [text, reason] of variants) {
    assert.notEqual(text, original, 'the edit did not apply, so this would test the untouched file');
    writeFileSync(marketplace, text);
    git(repo, ['commit', '-q', '-am', 'hand edit']);
    const clean = repoState(repo);
    assertRefused(release(repo, [nextMinor(repo)]), 1, reason);
    assert.deepEqual(repoState(repo), clean);
    git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
  }
});

// Once a release has tracked plugin/dist, any later build rewrites it; the
// next release rebuilds it anyway, so that change alone does not block it.
test('after a release has tracked plugin/dist, a rebuilt bundle does not block the next one', (t) => {
  const repo = releaseRepo(t);
  const first = nextMinor(repo);
  assert.equal(release(repo, [first]).status, 0);
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--ff-only', `release/v${first}`]);
  appendFileSync(join(repo, PLUGIN_BUNDLE), '// a later build\n');
  const second = release(repo, [nextMinor(repo)]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(blob(repo, `HEAD:${PLUGIN_BUNDLE}`), fileBlob(repo, 'packages/cli/dist/epic-pulse.mjs'));
});
