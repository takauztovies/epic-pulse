import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeSnapshot } from '@epic-pulse/core';
import { bashPayload, demoSnapshot, eventPayload, statusPayload } from './fixtures.js';
import { DEMO_REMOTE, git, registryOf } from './helpers.js';
import { documentedFiles, documentedForm, inventory, run, scene } from './privacy-scene.js';

// The README lists every file epic-pulse writes. A day's work, run through the
// real commands, must leave exactly those files and touch nothing else.

// Documented files this run can not leave behind, and why.
const NOT_IN_THIS_RUN: ReadonlyMap<string, string> = new Map([
  ['<git-common-dir>/epic-pulse/hook.log.1', 'only once hook.log passes 64 KiB, which hook.test.ts covers'],
  ['<git-common-dir>/epic-pulse/refresh.lock', 'held only while a refresh runs, so it must be gone afterwards'],
  ['<user-cache-dir>/epic-pulse/usage.jsonl', 'charged only by a request, and this refresh is served from cache; the token test sends one'],
  ['<user-cache-dir>/epic-pulse/usage.lock', 'held only while the ledger is written'],
]);

test('a session\'s hook calls, a pin, a cached refresh and the status line write exactly the documented files', async (t) => {
  const where = scene(t, DEMO_REMOTE);
  const before = inventory(where);
  for (const input of [eventPayload('SessionStart', where.repo), bashPayload('gh issue comment 4 -b hi', where.repo), 'not a payload']) {
    assert.equal((await run(where, ['hook'], input)).code, 0);
  }
  assert.equal((await run(where, ['track', '8', '--repo'])).code, 0);
  // What an earlier refresh fetched from GitHub, recorded from the demo issues.
  await writeSnapshot(registryOf(where.repo).snapshotFile, demoSnapshot(Date.now()));
  const refreshed = await run(where, ['refresh']);
  assert.deepEqual([refreshed.code, refreshed.stdout], [0, 'epic-pulse: refreshed with 0 request(s) and 0 point(s).\n']);
  assert.match((await run(where, ['statusline'], statusPayload(where.repo))).stdout, /^#1 /);

  const after = inventory(where);
  assert.equal(git(where.repo, ['status', '--porcelain', '--ignored', '--untracked-files=all']), '');
  assert.deepEqual([...before].filter(([file, sha]) => after.get(file) !== sha).map(([file]) => file), []);
  const created = [...after.keys()].filter((file) => !before.has(file)).map((file) => documentedForm(where, file));
  const documented = documentedFiles();
  assert.deepEqual([...NOT_IN_THIS_RUN.keys()].filter((file) => !documented.includes(file)), [], 'an exception names a file the README no longer lists');
  assert.deepEqual(created.sort(), documented.filter((file) => !NOT_IN_THIS_RUN.has(file)).sort());
});
