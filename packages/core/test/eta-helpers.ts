import { refKey } from '../src/ref.js';
import type { Status } from '../src/schemas/common.js';
import { SnapshotSchema, type Child, type Snapshot } from '../src/schemas/snapshot.js';
import { demo, demoSnapshot } from './snapshot-helpers.js';

// What a test says about the items of an epic: how long before `now` each one
// finished (`undefined`: closed as done with no close date recorded, as every
// close was before the snapshot kept them), and how many are in each other status.
export interface Items {
  readonly done?: readonly (number | undefined)[];
  readonly todo?: number;
  readonly in_progress?: number;
  readonly in_review?: number;
  readonly dropped?: number;
}

const OTHER: readonly Exclude<Status, 'done'>[] = ['todo', 'in_progress', 'in_review', 'dropped'];

// The recorded demo epic #1 has an item in every status; these are the items
// the test's are copied from, so each one is as recorded but for its number
// (from 100, clear of every epic in the demo) and its close date.
function itemsOf(now: number, items: Items, first: number): readonly Child[] {
  const recorded = demoSnapshot(now).epics[refKey(demo(1))]!.children;
  const template = (status: Status): Child => recorded.find((child) => child.status === status)!;
  // The recorded close date is dropped either way: a re-recording moves it.
  const undated: Child = { ...template('done'), closedAt: undefined };
  const done = (items.done ?? []).map((before) => (before === undefined ? undated : { ...undated, closedAt: now - before }));
  const other = OTHER.flatMap((status) => Array.from({ length: items[status] ?? 0 }, () => template(status)));
  return [...done, ...other].map((child, index) => ({ ...child, number: first + index }));
}

// The recorded demo snapshot with epic #1's items replaced by `own`, and, when
// `below` is given, a sub-epic #4 under it holding those items. Pin #1 to see it.
export function pacedSnapshot(now: number, own: Items, below?: Items): Snapshot {
  const base = demoSnapshot(now);
  const key = refKey(demo(1));
  const entry = base.epics[key]!;
  const sub = entry.children.find((child) => child.number === 4)!;
  const children = [...itemsOf(now, own, 100), ...(below === undefined ? [] : [sub])];
  const underneath = below === undefined ? {} : { [refKey(demo(4))]: { ...entry, ref: demo(4), children: itemsOf(now, below, 200) } };
  return SnapshotSchema.parse({ ...base, epics: { ...base.epics, [key]: { ...entry, children }, ...underneath } });
}
