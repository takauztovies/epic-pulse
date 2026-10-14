import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseProject } from '../src/board-config.js';
import { parseBoardPage, type BoardPage } from '../src/board-query.js';
import { boardEntry } from '../src/board.js';
import type { RawResponse } from '../src/github.js';
import { parsePhaseB } from '../src/queries.js';
import { refKey } from '../src/ref.js';
import { applyEpics } from '../src/refresh-apply.js';
import { safeChars, safeText } from '../src/schemas/common.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { emptySnapshot, readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';
import { tempDir } from './repo-helpers.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

// Titles and board option names are chosen by whoever can edit an issue or a
// board, and are printed: doctor writes the unmapped option names to a
// terminal. So are an epic's summary, which the VS Code hover shows, and an
// assignee, which on Jira is a display name its owner typed. Each goes through
// safeText on its way into the snapshot, and again on its way out of one an
// older version wrote.

const T0 = Date.parse('2026-10-12T12:00:00Z');
const PROJECT = parseProject({ owner: 'takauztovies', number: 3 })!;

// Every C0 control, DEL, every C1 control (U+009B is a one-byte CSI), and the
// bidi controls that reorder a line: marks (U+061C is the Arabic one),
// embeddings, overrides, isolates. And the line and paragraph separators, where
// a terminal or an editor that follows the Unicode line-break rules starts a
// line of its own.
const CONTROLS = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)];
const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const SEPARATORS = [0x2028, 0x2029];

test('every control, bidi and line separator character reads as ?, one for one', () => {
  for (const code of [...CONTROLS, ...BIDI, ...SEPARATORS]) assert.equal(safeChars(`a${String.fromCharCode(code)}b`), 'a?b', `U+${code.toString(16)}`);
});

// A ZWJ (woman, ZWJ, laptop) and a VS16 (warning sign, VS16) are format and
// mark characters an emoji needs, not controls. An Arabic word is text too: of
// its script only the mark U+061C is a control.
test('an emoji keeps its ZWJ and VS16, and other text is left as it is', () => {
  for (const text of ['\u{1F469}\u200d\u{1F4BB} Pairing', '\u26a0\ufe0f Blocked', 'In Progress', '\u0645\u0631\u062d\u0628\u0627', 'Prüfung · «QA» #4']) assert.equal(safeText(100).parse(text), text);
});

test('the text is cut at the cap after the pass, and text at the cap is not cut', () => {
  assert.equal(safeText(5).parse('\u001babcdefgh'), '?abcd');
  assert.equal(safeText(300).parse('y'.repeat(300)), 'y'.repeat(300));
});

// The cap counts UTF-16 units, so one that falls between the two halves of an
// emoji would keep the first half: a lone surrogate, which is not text and which
// a terminal or a file shows as U+FFFD. The emoji goes whole instead, and the
// text never grows past the cap to make room for it.
const GRIN = '\u{1F600}';

test('a cap inside an emoji drops it whole, and no cap leaves a lone surrogate', () => {
  const text = `ab${GRIN}cd`;
  assert.equal(safeText(2).parse(text), 'ab');
  assert.equal(safeText(3).parse(text), 'ab', 'the cut falls between its halves');
  assert.equal(safeText(4).parse(text), `ab${GRIN}`, 'a cap after it keeps it');
  assert.equal(safeText(9).parse('ab\ud83d'), 'ab', 'half an emoji that arrived that way goes too');
  for (let max = 0; max <= text.length; max++) {
    const cut = safeText(max).parse(text);
    assert.doesNotMatch(cut, /\p{Cs}/u, `cap ${max}`);
    assert.ok(cut.length <= max && text.startsWith(cut), `cap ${max}`);
  }
});

// The cut that leaves half an emoji in practice is not safeText's own: buildEpic
// slices a title at 300 units before the snapshot parses it, so by then the text
// is at the cap and safeText cuts nothing. Epic #1's title, renamed in GitHub's
// answer to one whose emoji straddles unit 300.
test('a title cut at 300 units inside an emoji is stored without its first half', async (t) => {
  const recording = loadFixture('phase-b-subissues');
  const renamed = JSON.stringify(recording.body).replace(JSON.stringify('Demo epic: sample onboarding flow'), () => JSON.stringify(`${'t'.repeat(299)}${GRIN}tail`));
  const parsed = parsePhaseB({ ...recording, body: JSON.parse(renamed) as unknown });
  assert.ok(parsed.ok);
  const built = applyEpics(emptySnapshot(T0), [[demo(1), parsed.value.epics.get(1) ?? null]], T0);
  assert.match(built.epics[refKey(demo(1))]?.title ?? '', /[\uD800-\uDBFF]$/, 'buildEpic leaves the first half');
  const file = join(tempDir(t), 'snapshot.json');
  await writeSnapshot(file, built);
  const read = await readSnapshot(file);
  assert.ok(read.status === 'ok');
  assert.equal(read.snapshot.epics[refKey(demo(1))]?.title, 't'.repeat(299));
});

// Todo and In Progress renamed by someone who can edit the board: an escape
// sequence and a one-byte CSI (U+009B), then a right-to-left override (U+202E)
// before an emoji held together by a ZWJ. Neither maps to a status.
const HOSTILE: Readonly<Record<string, string>> = { Todo: '\u001b[2J\u009b31mBlocked', 'In Progress': '\u202e\u{1F469}\u200d\u{1F4BB} Pairing' };
const SHOWN = ['?[2J?31mBlocked', '?\u{1F469}\u200d\u{1F4BB} Pairing'];

// An epic's summary and a child's assignee: a line separator beside an escape
// sequence, and an override and an Arabic letter mark round a name.
const SUMMARY = 'Ship the demo\u2028Status: done\u001b[2K';
const ASSIGNEE = '\u202eEve\u061c';
const CLEAN = [...SHOWN, SHOWN, 'Ship the demo?Status: done?[2K', ['?Eve?']];

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
// unmapped options, with the epic's summary and the child's assignee.
function storedRaw(): Snapshot {
  const snapshot = demoSnapshot(T0);
  const epic = snapshot.epics[refKey(demo(1))]!;
  const [first, ...rest] = epic.children;
  const page: BoardPage = { items: Object.values(HOSTILE).map((option, i) => ({ key: `takauztovies/epic-pulse#${5 + i}`, option })), next: null };
  const titled = { ...epic, title: HOSTILE['Todo']!, summary: SUMMARY, children: [{ ...first!, title: HOSTILE['In Progress']!, assignees: [ASSIGNEE] }, ...rest] };
  return { ...snapshot, epics: { ...snapshot.epics, [refKey(demo(1))]: titled }, board: boardEntry(PROJECT, [page], T0) };
}

function names(snapshot: Snapshot): readonly unknown[] {
  const epic = snapshot.epics[refKey(demo(1))];
  return [epic?.title, epic?.children[0]?.title, snapshot.board?.unmapped, epic?.summary, epic?.children[0]?.assignees];
}

test('titles, summaries, assignees and option names an older version stored raw read back clean, and are stored clean', async (t) => {
  const file = join(tempDir(t), 'snapshot.json');
  const raw = storedRaw();
  assert.deepEqual(names(raw), [...Object.values(HOSTILE), Object.values(HOSTILE), SUMMARY, [ASSIGNEE]], 'the hostile names are in place');
  writeFileSync(file, JSON.stringify(raw));
  const read = await readSnapshot(file);
  assert.ok(read.status === 'ok');
  assert.deepEqual(names(read.snapshot), CLEAN);
  await writeSnapshot(file, raw);
  assert.deepEqual(names(JSON.parse(readFileSync(file, 'utf8')) as Snapshot), CLEAN);
});
