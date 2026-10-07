import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathsFor, pinsOf, readPins, refKey } from '@epic-pulse/core';
import { trackIn, untrackEverywhere } from '../src/track.js';
import { demo, makeRegistry } from './registry-helpers.js';

// No real .git here (makeRegistry's folder is a plain temp directory), so only
// forms that name their own repository resolve; a bare number has nothing to
// default to, which is itself one of the cases below.

async function pinnedKeys(dir: string): Promise<readonly string[]> {
  return pinsOf(await readPins(pathsFor(dir))).map((pin) => refKey(pin.ref));
}

test('trackIn pins an explicit owner/repo#N, and is idempotent', async (t) => {
  const repo = await makeRegistry(t, {});
  const first = await trackIn(repo, 'takauztovies/epic-pulse#8', Date.now());
  assert.deepEqual([first.ok, first.message], [true, 'epic-pulse: pinned takauztovies/epic-pulse#8.']);
  assert.deepEqual(await pinnedKeys(repo.dir), [refKey(demo(8))]);
  const second = await trackIn(repo, 'takauztovies/epic-pulse#8', Date.now());
  assert.deepEqual([second.ok, second.message], [true, 'epic-pulse: takauztovies/epic-pulse#8 was already pinned.']);
});

test('trackIn pins an issue URL the same way', async (t) => {
  const repo = await makeRegistry(t, {});
  const result = await trackIn(repo, 'https://github.com/takauztovies/epic-pulse/issues/4', Date.now());
  assert.deepEqual([result.ok, await pinnedKeys(repo.dir)], [true, [refKey(demo(4))]]);
});

test('trackIn refuses a bare number with no repository to default it to', async (t) => {
  const repo = await makeRegistry(t, {});
  const result = await trackIn(repo, '8', Date.now());
  assert.deepEqual([result.ok, await pinnedKeys(repo.dir)], [false, []]);
  assert.match(result.message, /no GitHub remote to default to/);
});

test('untrackEverywhere removes the pin from whichever repository has it, and no-ops on the rest', async (t) => {
  const pinned = await makeRegistry(t, { pins: [demo(8)] });
  const empty = await makeRegistry(t, {});
  const url = 'https://github.com/takauztovies/epic-pulse/issues/8';
  const result = await untrackEverywhere([empty, pinned], url);
  assert.deepEqual([result.ok, result.message], [true, 'epic-pulse: unpinned takauztovies/epic-pulse#8.']);
  assert.deepEqual([await pinnedKeys(pinned.dir), await pinnedKeys(empty.dir)], [[], []]);
});

test('untrackEverywhere says so when the epic was never pinned anywhere', async (t) => {
  const repo = await makeRegistry(t, {});
  const result = await untrackEverywhere([repo], 'https://github.com/takauztovies/epic-pulse/issues/8');
  assert.deepEqual([result.ok, result.message], [true, 'epic-pulse: takauztovies/epic-pulse#8 was not pinned.']);
});

test('untrackEverywhere refuses a URL it can not parse as an issue', async (t) => {
  const repo = await makeRegistry(t, {});
  const result = await untrackEverywhere([repo], 'https://example.invalid/not-an-issue');
  assert.equal(result.ok, false);
});
