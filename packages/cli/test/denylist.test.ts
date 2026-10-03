import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIGEST, KEY, repoWith, run, WORD } from './denylist-helpers.js';
import { ROOT } from './helpers.js';

// scripts/check-denylist.mjs fails on any word whose HMAC-SHA256 digest, under
// a secret key, is listed in scripts/denylist.hmac. These tests run it, in
// throwaway repositories with a list of their own, under a throwaway key, on
// one nonsense word. The real list is checked where the real key is: in CI.

const WITH_KEY = { env: { EPIC_PULSE_DENYLIST_KEY: KEY } };
const HIT = (place: string) => `epic-pulse: ${place} holds a denylisted word (hmac ${DIGEST.slice(0, 12)}...)\n`;

test('the check reads the repository, its fixtures and its built bundles', (t) => {
  const result = run(t, ROOT, WITH_KEY);
  assert.equal(result.status, 0, result.out);
  const files = Number(/no denylisted word in (\d+) files/.exec(result.out)?.[1] ?? 0);
  assert.ok(files > 150, `only ${files} files were read, so the check looked at too little`);
});

test('a listed word in a tracked file, in any case, fails the check, which names the place and not the word', (t) => {
  const repo = repoWith(t, { 'notes/plan.md': `line one\nWe met the ${WORD.toUpperCase()}-team.\n` });
  const result = run(t, repo, WITH_KEY);
  assert.deepEqual(result, { status: 1, out: HIT('notes/plan.md:2') });
  assert.equal(result.out.toLowerCase().includes(WORD), false, 'the check printed the word it hides');
});

test('a listed word in what a build wrote fails it too, though dist is not tracked', (t) => {
  const repo = repoWith(t, { 'README.md': 'clean\n' });
  mkdirSync(join(repo, 'plugin', 'dist'), { recursive: true });
  writeFileSync(join(repo, 'plugin', 'dist', 'epic-pulse.mjs'), `const x = "${WORD}";\n`);
  assert.deepEqual(run(t, repo, WITH_KEY), { status: 1, out: HIT('plugin/dist/epic-pulse.mjs:1') });
});

// The digest in the list is only the word's HMAC under KEY: under any other key
// the same word hashes to something else and the list matches nothing.
test('a word is listed under its key only: another key finds nothing', (t) => {
  const repo = repoWith(t, { 'notes/plan.md': `We met the ${WORD}.\n` });
  const result = run(t, repo, { env: { EPIC_PULSE_DENYLIST_KEY: `${KEY}-but-another` } });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /^epic-pulse: no denylisted word in 1 files\.\n$/);
});

// A line one character short would never match anything.
test('a denylist line that is not a digest is refused rather than skipped, with a key or without', (t) => {
  const list = `# a comment\n\n${DIGEST.slice(1)}\n`;
  const repo = repoWith(t, { 'README.md': 'clean\n' }, list);
  const refused = { status: 2, out: 'epic-pulse: scripts/denylist.hmac line 3: not an HMAC-SHA256 hex digest\n' };
  assert.deepEqual(run(t, repo, WITH_KEY), refused);
  assert.deepEqual(run(t, repo), refused);
});
