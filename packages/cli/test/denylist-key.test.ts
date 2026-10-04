import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIGEST, homeWithKey, KEY, repoWith, run, WORD } from './denylist-helpers.js';
import { tempDir } from './helpers.js';

// Where the key of scripts/check-denylist.mjs comes from, and what a missing
// one means: nothing for a person or a fork, a failure for CI on this
// repository's own pushes and pull requests, which have the secret.

const PLANTED = { 'notes/plan.md': `We met the ${WORD}.\n` };
const FOUND = { status: 1, out: `epic-pulse: notes/plan.md:1 holds a denylisted word (hmac ${DIGEST.slice(0, 12)}...)\n` };
const SKIPPED = { status: 0, out: 'denylist: skipped (no key)\n' };
const CI = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/epic-pulse' };
const NO_KEY_IN_CI = { status: 2, out: '::error::denylist: no key on a run of owner/epic-pulse. CI gives its own runs the DENYLIST_KEY secret; set it, or this check guards nothing.\n' };

test('the key can come from ~/.config/epic-pulse/denylist.key, newline and all', (t) => {
  const repo = repoWith(t, PLANTED);
  assert.deepEqual(run(t, repo, { home: homeWithKey(t, `${KEY}\n`) }), FOUND);
});

test('the environment key wins over the file, and its surrounding whitespace is not part of it', (t) => {
  const repo = repoWith(t, PLANTED);
  const home = homeWithKey(t, 'the wrong key');
  assert.deepEqual(run(t, repo, { home, env: { EPIC_PULSE_DENYLIST_KEY: ` ${KEY}\n` } }), FOUND);
});

test('a key file that exists but can not be read is an error, not a missing key', (t) => {
  const home = tempDir(t, 'ep-home-');
  mkdirSync(join(home, '.config', 'epic-pulse', 'denylist.key'), { recursive: true });
  const result = run(t, repoWith(t, PLANTED), { home });
  assert.equal(result.status, 2);
  assert.match(result.out, /^epic-pulse: .*denylist\.key can not be read \(EISDIR\)\n$/);
});

test('without a key the check says so and passes, though the word is there', (t) => {
  assert.deepEqual(run(t, repoWith(t, PLANTED)), SKIPPED);
});

test('without a key a pull request from a fork passes: GitHub gives it no secrets', (t) => {
  const env = { ...CI, GITHUB_EVENT_NAME: 'pull_request', HEAD_REPO: 'someone/epic-pulse' };
  assert.deepEqual(run(t, repoWith(t, PLANTED), { env }), SKIPPED);
});

// Each of these has the secret, so a missing key is a mistake: it was never
// set, or the workflow names it wrongly. A pull request whose head repository
// is not given is not known to be a fork, so it counts as one of ours.
test('without a key, CI on this repository fails instead of passing unchecked', (t) => {
  const repo = repoWith(t, PLANTED);
  const events = [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'push', HEAD_REPO: 'owner/epic-pulse' },
    { GITHUB_EVENT_NAME: 'pull_request', HEAD_REPO: 'owner/epic-pulse' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  ];
  for (const event of events) assert.deepEqual(run(t, repo, { env: { ...CI, ...event } }), NO_KEY_IN_CI, JSON.stringify(event));
});

// An unset secret is not an absent variable: `${{ secrets.X }}` expands to an
// empty string, and that is what a mistyped name reaches the script as.
test('an empty or blank key is no key', (t) => {
  const repo = repoWith(t, PLANTED);
  const event = { ...CI, GITHUB_EVENT_NAME: 'pull_request', HEAD_REPO: 'owner/epic-pulse' };
  for (const blank of ['', '  \n']) {
    assert.deepEqual(run(t, repo, { env: { ...event, EPIC_PULSE_DENYLIST_KEY: blank } }), NO_KEY_IN_CI, JSON.stringify(blank));
    assert.deepEqual(run(t, repo, { env: { EPIC_PULSE_DENYLIST_KEY: blank } }), SKIPPED, JSON.stringify(blank));
  }
});

test('with its key, CI on this repository checks like anywhere else', (t) => {
  const env = { ...CI, GITHUB_EVENT_NAME: 'pull_request', HEAD_REPO: 'owner/epic-pulse', EPIC_PULSE_DENYLIST_KEY: KEY };
  assert.deepEqual(run(t, repoWith(t, PLANTED), { env }), FOUND);
});
