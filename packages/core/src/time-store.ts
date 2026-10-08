import { readdir, readFile, stat } from 'node:fs/promises';
import { atomicWriteFile } from './atomic.js';
import type { RegistryPaths } from './paths.js';
import { advanceTime, EMPTY_TIME } from './time.js';
import { parseLines, sessionFile } from './registry.js';
import { parseJson } from './result.js';
import type { RegistryLine } from './schemas/registry.js';
import { TimeFileSchema, type TimeFile } from './schemas/time.js';

// Counting needs a session's whole file, not the tail the status line reads.
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_TIME_BYTES = 1024 * 1024;
const MAX_REFS = 5000;

export async function readTime(paths: RegistryPaths): Promise<TimeFile> {
  try {
    if ((await stat(paths.timeFile)).size > MAX_TIME_BYTES) return EMPTY_TIME;
    const parsed = TimeFileSchema.safeParse(parseJson(await readFile(paths.timeFile, 'utf8')));
    return parsed.success ? parsed.data : EMPTY_TIME;
  } catch {
    return EMPTY_TIME;
  }
}

async function allSessionLines(paths: RegistryPaths): Promise<ReadonlyMap<string, readonly RegistryLine[]>> {
  const names = await readdir(paths.sessionsDir).catch(() => [] as string[]);
  const found = await Promise.all(names.filter((name) => name.endsWith('.jsonl')).map(async (name) => {
    const id = name.slice(0, -'.jsonl'.length);
    const file = sessionFile(paths, id);
    const info = file ? await stat(file).catch(() => undefined) : undefined;
    if (!file || !info?.isFile() || info.size > MAX_SESSION_BYTES) return [];
    return [[id, parseLines(await readFile(file, 'utf8').catch(() => ''))] as const];
  }));
  return new Map(found.flat());
}

// The least recently active issues go first once there are too many.
function capped(time: TimeFile): TimeFile {
  const entries = Object.entries(time.refs);
  if (entries.length <= MAX_REFS) return time;
  const kept = entries.sort((a, b) => b[1].lastTs - a[1].lastTs).slice(0, MAX_REFS);
  return { ...time, refs: Object.fromEntries(kept) };
}

// Called by the refresher, before old session files are pruned. A reader
// never writes: it uses advancedTime's result in memory.
export async function updateTime(paths: RegistryPaths): Promise<TimeFile> {
  const next = capped(advanceTime(await readTime(paths), await allSessionLines(paths)));
  // A failed save only delays the count: the next refresh reads the same
  // lines from the same watermark and counts them then.
  await atomicWriteFile(paths.timeFile, `${JSON.stringify(TimeFileSchema.parse(next))}\n`).catch(() => undefined);
  return next;
}
