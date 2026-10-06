import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, parseConfig } from '../src/config.js';
import { DEFAULT_PROGRESS, parseProgress } from '../src/progress-config.js';
import { tempDir } from './repo-helpers.js';

test('with nothing configured, progress is the defaults: a quarter, three quarters, and the size/ table with medium for the unsized', () => {
  assert.deepEqual(DEFAULT_PROGRESS, { inProgress: 25, inReview: 75, sizes: { 'size/xs': 1, 'size/s': 2, 'size/m': 3, 'size/l': 5, 'size/xl': 8 }, unsized: 3 });
  for (const value of [undefined, null, 'x', 4, [], {}]) assert.deepEqual(parseProgress(value), DEFAULT_PROGRESS);
  assert.deepEqual(DEFAULT_CONFIG.progress, DEFAULT_PROGRESS);
  assert.deepEqual(parseConfig({ ignorePaths: ['docs'] }).progress, DEFAULT_PROGRESS);
});

test('a valid progress block replaces the defaults, sizes as a whole table, size names case-folded', () => {
  const progress = parseProgress({ inProgress: 50, inReview: 90, sizes: { 'Est:1': 1, 'est:4': 4, 'est:9': 9 }, unsized: 2 });
  assert.deepEqual(progress, { inProgress: 50, inReview: 90, sizes: { 'est:1': 1, 'est:4': 4, 'est:9': 9 }, unsized: 2 });
});

test('each field is checked on its own: a bad one falls back to its default without voiding the others', () => {
  assert.deepEqual(parseProgress({ inProgress: 80, inReview: 40, unsized: 2 }), { ...DEFAULT_PROGRESS, unsized: 2 }, 'in review below in progress is no order');
  for (const bad of [100, 120, -1, 2.5, '50', null]) {
    assert.equal(parseProgress({ inProgress: bad }).inProgress, 25, `inProgress ${String(bad)}`);
    assert.equal(parseProgress({ inReview: bad }).inReview, 75, `inReview ${String(bad)}`);
  }
  assert.deepEqual(parseProgress({ sizes: { 'size/s': 0, 'Size/L': 4, '': 2, 'size/m': 1.5, 'size/xl': 1001 } }).sizes, { 'size/l': 4 });
  assert.deepEqual(parseProgress({ sizes: { a: 0, b: -2 } }).sizes, DEFAULT_PROGRESS.sizes, 'no valid size at all keeps the table');
  assert.equal(parseProgress({ unsized: 0 }).unsized, 3);
});

test('without an unsized value an unlabelled item is worth the lower median of the sizes', () => {
  assert.equal(parseProgress({ sizes: { a: 1, b: 9 } }).unsized, 1);
  assert.equal(parseProgress({ sizes: { a: 1, b: 2, c: 7 } }).unsized, 2);
  assert.equal(parseProgress({ sizes: { a: 4 } }).unsized, 4);
});

test('the repository file is read from disk through loadConfig', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ progress: { inProgress: 40, sizes: { 'pts:3': 3 } } }));
  const { progress } = await loadConfig(dir);
  assert.deepEqual([progress.inProgress, progress.inReview, progress.sizes, progress.unsized], [40, 75, { 'pts:3': 3 }, 3]);
});
