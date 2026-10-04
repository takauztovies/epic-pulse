import { randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir, errnoOf } from './atomic.js';

export interface Lock {
  readonly path: string;
  readonly token: string;
}

export interface AcquireOptions {
  readonly now: number;
  readonly staleMs: number;
}

async function tryCreate(path: string): Promise<Lock | undefined> {
  const token = randomUUID();
  try {
    const handle = await open(path, 'wx', 0o600); // 'wx' = create, fail if it exists: the only atomic primitive we rely on
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    await handle.close();
    return { path, token };
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return undefined;
    throw error;
  }
}

async function isStale(path: string, options: AcquireOptions): Promise<boolean> {
  try {
    return options.now - (await stat(path)).mtimeMs > options.staleMs;
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return true; // released between our create and our stat
    throw error;
  }
}

// Single-flight lock. A holder that died (crash, kill -9) leaves its file
// behind, so a lock whose mtime is older than `staleMs` is taken over. Two
// processes can both decide a lock is stale and both take over; the cost is one
// duplicate refresh, which is harmless because the snapshot write is atomic.
export async function acquireLock(path: string, options: AcquireOptions): Promise<Lock | undefined> {
  await ensureDir(dirname(path));
  const first = await tryCreate(path);
  if (first) return first;
  if (!(await isStale(path, options))) return undefined;
  await unlink(path).catch(() => undefined);
  return tryCreate(path);
}

// Long refreshes extend their claim so a live holder is never taken over.
export async function touchLock(lock: Lock, now: number): Promise<void> {
  const seconds = now / 1000;
  await utimes(lock.path, seconds, seconds).catch(() => undefined);
}

// Only delete a lock that is still ours. If we were taken over after going
// stale, the file belongs to the new holder and must survive our release.
export async function releaseLock(lock: Lock): Promise<void> {
  try {
    const held = JSON.parse(await readFile(lock.path, 'utf8')) as { token?: unknown };
    if (held.token === lock.token) await unlink(lock.path);
  } catch {
    // already gone or unreadable: nothing of ours left to release
  }
}
