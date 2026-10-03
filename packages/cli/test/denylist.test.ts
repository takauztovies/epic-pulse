import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIGEST, KEY, KEY_CHECK, repoWith, run, scriptWithList, WORD } from './denylist-helpers.js';
import { ROOT } from './helpers.js';

// scripts/check-denylist.mjs fails on any word whose HMAC-SHA256 digest, under
// a secret key, is listed in scripts/denylist.hmac. These tests run it, in
// throwaway repositories with a list of their own, under a throwaway key, on
// one nonsense word. The real list is checked where the real key is: in CI.

const WITH_KEY = { env: { EPIC_PULSE_DENYLIST_KEY: KEY } };
const HIT = (place: string) => `epic-pulse: ${place} holds a denylisted word (hmac ${DIGEST.slice(0, 12)}...)\n`;

// The real list was made under the real key, which the tests do not have, so
// this runs a copy of the script over the real repository beside a list holding
// only the test key's key-check line (the helpers' recipe comment spells WORD).
test('the check reads the repository, its fixtures and its built bundles', (t) => {
  const result = run(t, ROOT, { ...WITH_KEY, script: scriptWithList(t, `${KEY_CHECK}\n`) });
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

// Under any other key every word hashes to something unlisted, so a wrong key
// would make the check find nothing and pass. The key-check line catches it.
test('a wrong key is refused instead of passing a tree it can not check', (t) => {
  const repo = repoWith(t, { 'notes/plan.md': `We met the ${WORD}.\n` });
  const result = run(t, repo, { env: { EPIC_PULSE_DENYLIST_KEY: `${KEY}-but-another` } });
  assert.deepEqual(result, {
    status: 2,
    out: 'epic-pulse: the key does not match the one scripts/denylist.hmac was made with, so this check would find nothing\n',
  });
});

test('a list with digests but no key-check line is refused, since any key would pass it', (t) => {
  const repo = repoWith(t, { 'notes/plan.md': `We met the ${WORD}.\n` }, `${DIGEST}\n`);
  assert.deepEqual(run(t, repo, WITH_KEY), {
    status: 2,
    out: 'epic-pulse: scripts/denylist.hmac has digests but no `key-check` line, so a wrong key would pass unnoticed\n',
  });
});

// A line one character short would never match anything.
test('a denylist line that is not a digest is refused rather than skipped, with a key or without', (t) => {
  const list = `# a comment\n\n${DIGEST.slice(1)}\n`;
  const repo = repoWith(t, { 'README.md': 'clean\n' }, list);
  const refused = { status: 2, out: 'epic-pulse: scripts/denylist.hmac line 3: not an HMAC-SHA256 hex digest\n' };
  assert.deepEqual(run(t, repo, WITH_KEY), refused);
  assert.deepEqual(run(t, repo), refused);
});
