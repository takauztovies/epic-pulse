import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathsFor } from '../src/paths.js';
import { addPin, pinsOf, readPins, removePin } from '../src/pins.js';
import { makeRef } from '../src/ref.js';
import { tempDir } from './repo-helpers.js';

const ref = (number: number) => makeRef({ host: 'github.com', owner: 'acme', repo: 'widgets', number })!;

test('a pin is added once, removed once, and read back from disk', async (t) => {
  const paths = pathsFor(tempDir(t));
  assert.deepEqual(await readPins(paths), { status: 'missing' });
  const pinned = [{ ref: ref(8), addedAt: 1000 }];
  assert.deepEqual(await addPin(paths, ref(8), 1000), { ok: true, value: { pins: pinned, changed: true } });
  assert.deepEqual(await addPin(paths, ref(8), 2000), { ok: true, value: { pins: pinned, changed: false } });
  assert.deepEqual(await readPins(paths), { status: 'ok', pins: pinned });
  assert.deepEqual(await removePin(paths, ref(8)), { ok: true, value: { pins: [], changed: true } });
  assert.deepEqual(await removePin(paths, ref(8)), { ok: true, value: { pins: [], changed: false } });
  if (process.platform !== 'win32') assert.equal(statSync(paths.pinsFile).mode & 0o777, 0o600);
});

test('a corrupt pins file reads as no pins and is never overwritten by add or remove', async (t) => {
  const paths = pathsFor(tempDir(t));
  mkdirSync(paths.dir, { recursive: true });
  for (const content of ['{"v":1,"pins":[', '[]', '{"v":2,"pins":[]}', 'x'.repeat(300 * 1024)]) {
    writeFileSync(paths.pinsFile, content);
    assert.deepEqual(await addPin(paths, ref(8), 1), { ok: false, error: 'corrupt' });
    assert.deepEqual(await removePin(paths, ref(8)), { ok: false, error: 'corrupt' });
    assert.equal(readFileSync(paths.pinsFile, 'utf8'), content);
    assert.deepEqual(pinsOf(await readPins(paths)), []);
  }
});

test('the pin list is capped at the schema limit', async (t) => {
  const paths = pathsFor(tempDir(t));
  mkdirSync(paths.dir, { recursive: true });
  const pins = Array.from({ length: 200 }, (_, i) => ({ ref: ref(i + 1), addedAt: 1 }));
  writeFileSync(paths.pinsFile, JSON.stringify({ v: 1, pins }));
  assert.deepEqual(await addPin(paths, ref(999), 1), { ok: false, error: 'full' });
  assert.deepEqual(await addPin(paths, ref(5), 1), { ok: true, value: { pins, changed: false } });
});
