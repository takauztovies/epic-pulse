import { readFile, stat } from 'node:fs/promises';
import { atomicWriteFile, errnoOf } from './atomic.js';
import { parseJson } from './result.js';
import { EpicEntrySchema, SnapshotSchema, type EpicEntry, type Snapshot } from './schemas/snapshot.js';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export type SnapshotRead =
  | { readonly status: 'ok'; readonly snapshot: Snapshot }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export function emptySnapshot(now: number): Snapshot {
  return {
    v: 1,
    updatedAt: now,
    issues: {},
    epics: {},
    usage: { windowStart: now, points: 0 },
    rateLimit: null,
    error: null,
    detail: null,
  };
}

// The status line reads this on every render and must never throw or hang on a
// bad file: missing, empty, oversized, truncated and wrong-shaped files are all
// reported as a state, and the caller shows it.
export async function readSnapshot(file: string): Promise<SnapshotRead> {
  try {
    if ((await stat(file)).size > MAX_SNAPSHOT_BYTES) return { status: 'corrupt' };
    const parsed = SnapshotSchema.safeParse(parseJson(await readFile(file, 'utf8')));
    return parsed.success ? { status: 'ok', snapshot: parsed.data } : { status: 'corrupt' };
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { status: 'missing' } : { status: 'corrupt' };
  }
}

// One epic the schema refuses must not cost the whole snapshot its write, and
// with it every other epic's refresh, on every run after it. That epic keeps
// its title and link but not its children, marked invalid_response, so it
// shows stale with that code; it still counts as fetched, so it is not asked
// for again before it is due. One that fails even so is left out.
function storable(entry: EpicEntry): readonly EpicEntry[] {
  if (EpicEntrySchema.safeParse(entry).success) return [entry];
  const marked: EpicEntry = { ...entry, children: [], truncated: true, error: 'invalid_response' };
  return EpicEntrySchema.safeParse(marked).success ? [marked] : [];
}

export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  const epics = Object.entries(snapshot.epics).flatMap(([key, entry]) => storable(entry).map((kept) => [key, kept] as const));
  await atomicWriteFile(file, `${JSON.stringify(SnapshotSchema.parse({ ...snapshot, epics: Object.fromEntries(epics) }))}\n`);
}
