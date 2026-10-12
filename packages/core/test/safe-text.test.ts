import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { parseBoardPage, type BoardPage } from '../src/board-query.js';
import { boardEntry } from '../src/board.js';
import type { RawResponse } from '../src/github.js';
import { refKey } from '../src/ref.js';
import { safeChars, safeText } from '../src/schemas/common.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

// Titles and board option names are chosen by whoever can edit an issue or a
// board, and are printed: doctor writes the unmapped option names to a
// terminal. Each goes through safeText on its way into the snapshot, and again
// on its way out of one an older version wrote.

const T0 = Date.parse('2026-10-12T12:00:00Z');
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;

// Every C0 control, DEL, every C1 control (U+009B is a one-byte CSI), and the
// bidi controls that reorder a line: marks, embeddings, overrides, isolates.
const CONTROLS = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)];
const BIDI = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

test('every control and bidi character reads as ?, one for one', () => {
  for (const code of [...CONTROLS, ...BIDI]) assert.equal(safeChars(`a${String.fromCharCode(code)}b`), 'a?b', `U+${code.toString(16)}`);
});

// A ZWJ (woman, ZWJ, laptop) and a VS16 (warning sign, VS16) are format and
// mark characters an emoji needs, not controls.
test('an emoji keeps its ZWJ and VS16, and other text is left as it is', () => {
  for (const text of ['\u{1F469}\u200d\u{1F4BB} Pairing', '\u26a0\ufe0f Blocked', 'In Progress', 'Prüfung · «QA» #4']) assert.equal(safeText(100).parse(text), text);
});

test('the text is cut at the cap after the pass, and text at the cap is not cut', () => {
  assert.equal(safeText(5).parse('\u001babcdefgh'), '?abcd');
  assert.equal(safeText(300).parse('y'.repeat(300)), 'y'.repeat(300));
});

// Todo and In Progress renamed by someone who can edit the board: an escape
// sequence and a one-byte CSI (U+009B), then a right-to-left override (U+202E)
// before an emoji held together by a ZWJ. Neither maps to a status.
const HOSTILE: Readonly<Record<string, string>> = { Todo: '\u001b[2J\u009b31mBlocked', 'In Progress': '\u202e\u{1F469}\u200d\u{1F4BB} Pairing' };
const SHOWN = ['?[2J?31mBlocked', '?\u{1F469}\u200d\u{1F4BB} Pairing'];

// The recorded demo board, renamed in GitHub's answer itself.
function hostileAnswer(): RawResponse {
  const recording = loadFixture('board-demo');
  const renamed = Object.entries(HOSTILE).reduce((text, [from, to]) => text.replace(JSON.stringify(from), () => JSON.stringify(to)), JSON.stringify(recording.body));
  return { ...recording, body: JSON.parse(renamed) as unknown };
}

test('an option name GitHub answers reads with ? for its control and bidi characters, and its emoji whole', () => {
  const page = parseBoardPage(hostileAnswer());
  assert.ok(page.ok);
  assert.deepEqual(page.value.items.map((item) => item.option), ['Done', ...SHOWN]);
});

// The demo snapshot as a version before safeText could have written it: the
// hostile names as epic #1's title, its first child's title, and the board's
// unmapped options.
function storedRaw(): Snapshot {
  const snapshot = demoSnapshot(T0);
  const epic = snapshot.epics[refKey(demo(1))]!;
  const [first, ...rest] = epic.children;
  const page: BoardPage = { items: Object.values(HOSTILE).map((option, i) => ({ key: `takauztovies/epic-pulse#${5 + i}`, option })), next: null };
  const titled = { ...epic, title: HOSTILE['Todo']!, children: [{ ...first!, title: HOSTILE['In Progress']! }, ...rest] };
  return { ...snapshot, epics: { ...snapshot.epics, [refKey(demo(1))]: titled }, board: boardEntry(PROJECT, [page], T0) };
}

function names(snapshot: Snapshot): readonly unknown[] {
  const epic = snapshot.epics[refKey(demo(1))];
  return [epic?.title, epic?.children[0]?.title, snapshot.board?.unmapped];
}

test('titles and option names an older version stored raw read back clean, and are stored clean', async (t) => {
  const file = join(tempDir(t), 'snapshot.json');
  const raw = storedRaw();
  assert.deepEqual(names(raw), [...Object.values(HOSTILE), Object.values(HOSTILE)], 'the hostile names are in place');
  writeFileSync(file, JSON.stringify(raw));
  const read = await readSnapshot(file);
  assert.ok(read.status === 'ok');
  assert.deepEqual(names(read.snapshot), [...SHOWN, SHOWN]);
  await writeSnapshot(file, raw);
  assert.deepEqual(names(JSON.parse(readFileSync(file, 'utf8')) as Snapshot), [...SHOWN, SHOWN]);
});
