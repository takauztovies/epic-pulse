import { readFile, stat } from 'node:fs/promises';
import { atomicWriteFile, errnoOf } from './atomic.js';
import { parseJson } from './result.js';
import { SnapshotSchema, type Snapshot } from './schemas/snapshot.js';

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

export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(SnapshotSchema.parse(snapshot))}\n`);
}
