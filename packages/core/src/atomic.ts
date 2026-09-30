import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;

export function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

// Owner-only: the registry holds issue titles from private repositories.
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

// Windows refuses to rename over a file another process has open (a reader
// mid-read), reporting EPERM/EBUSY. The window is milliseconds, so retry briefly.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE.has(code)) throw error;
      await sleep(15 * attempt);
    }
  }
}

// Write to a sibling temp file, then rename over the target. A reader sees the
// old file or the new one, never a truncated half-written one. The temp name is
// unique per call so concurrent writers do not clobber each other's temp file.
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600 });
    await renameWithRetry(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
