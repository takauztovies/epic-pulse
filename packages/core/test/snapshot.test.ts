import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeRef, refKey } from '../src/ref.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { tempDir } from './repo-helpers.js';

const EPIC = makeRef({ host: 'github.com', owner: 'acme', repo: 'widgets', number: 1 })!;

// `padding` children with maximal titles make the file big enough that a
// non-atomic writer would take several chunks to write it.
function sample(now: number, padding = 0): Snapshot {
  return {
    ...emptySnapshot(now),
    epics: {
      [refKey(EPIC)]: {
        ref: EPIC, title: 'Epic', url: 'https://github.com/acme/widgets/issues/1', kind: 'subissues',
        children: [{ number: 2, title: 'child', url: null, status: 'done' as const }, ...Array.from({ length: padding }, () => (
          { number: null, title: 'y'.repeat(300), url: null, status: 'todo' as const }))],
        truncated: false, fetchedAt: now, error: null,
      },
    },
  };
}

test('a snapshot round-trips and no temp file is left behind', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'nested', 'snapshot.json');
  await writeSnapshot(file, sample(1000));
  assert.deepEqual(await readSnapshot(file), { status: 'ok', snapshot: sample(1000) });
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['snapshot.json']);
});

test('missing, empty, truncated, wrong-shaped and oversized files are states, not exceptions', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'snapshot.json');
  assert.deepEqual(await readSnapshot(file), { status: 'missing' });
  for (const content of ['', '{"v":1,"updat', '[]', '{"v":2}', 'null', JSON.stringify({ ...sample(1), epics: { x: 1 } }), 'x'.repeat(6 * 1024 * 1024)]) {
    writeFileSync(file, content);
    assert.deepEqual(await readSnapshot(file), { status: 'corrupt' }, content.slice(0, 20));
  }
});

test('a directory where the file should be is corrupt, not a crash', async (t) => {
  assert.deepEqual(await readSnapshot(tempDir(t)), { status: 'corrupt' });
});

test('concurrent writers never expose a torn snapshot to readers', async (t) => {
  const file = join(tempDir(t), 'snapshot.json');
  await writeSnapshot(file, sample(0));
  const writes = Array.from({ length: 30 }, (_, i) => writeSnapshot(file, sample(i, 400)));
  const reads = Array.from({ length: 60 }, () => readSnapshot(file));
  const [, seen] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
  assert.equal(seen.length, 60);
  assert.ok(seen.every((read) => read.status === 'ok'));
});

// One child more than the schema keeps. A single epic like that must not cost
// every other epic its write, on every run after it.
test('an epic the schema refuses is written without its children, marked invalid_response, and the rest as it was', async (t) => {
  const file = join(tempDir(t), 'snapshot.json');
  const good = sample(1000).epics[refKey(EPIC)]!;
  const other = makeRef({ ...EPIC, number: 2 })!;
  const bad = { ...sample(1000, 500).epics[refKey(EPIC)]!, ref: other };
  await writeSnapshot(file, { ...sample(1000), epics: { [refKey(EPIC)]: good, [refKey(other)]: bad } });
  const read = await readSnapshot(file);
  assert.ok(read.status === 'ok');
  assert.deepEqual(read.snapshot.epics[refKey(EPIC)], good);
  assert.deepEqual(read.snapshot.epics[refKey(other)], { ...bad, children: [], truncated: true, error: 'invalid_response' });
});
