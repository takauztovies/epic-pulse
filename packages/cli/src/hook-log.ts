import { appendFile, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureDir, parseJson } from '@epic-pulse/core';

export const HOOK_LOG = 'hook.log';
// About a thousand lines. Past this the log moves to hook.log.1, replacing the
// one before, so the two files together stay under twice this size.
export const MAX_LOG_BYTES = 64 * 1024;

// The registry's own codes come first; `record` in hook.ts returns them as
// they are, so the compiler notices a code core adds that is missing here.
export const HOOK_ERROR_CODES = [
  'invalid_session', 'invalid_line', 'line_too_large', 'io',
  'invalid_payload', 'payload_too_large', 'extract_failed', 'runtime_copy_failed',
] as const;
export type HookErrorCode = (typeof HOOK_ERROR_CODES)[number];

const LogLineSchema = z.object({ ts: z.number().int().nonnegative(), code: z.enum(HOOK_ERROR_CODES) });
export type LogLine = z.infer<typeof LogLineSchema>;

// A code and a timestamp, nothing else: the hook reads the user's commands and
// file contents, and none of that, not even a library message, may reach disk.
export async function logHookError(dir: string, code: HookErrorCode, now: number): Promise<void> {
  const file = join(dir, HOOK_LOG);
  const size = await stat(file).then((info) => info.size, () => 0);
  if (size >= MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
  await ensureDir(dir);
  await appendFile(file, `${JSON.stringify({ ts: now, code })}\n`, { mode: 0o600 });
}

export async function lastHookError(dir: string): Promise<LogLine | undefined> {
  const text = await readFile(join(dir, HOOK_LOG), 'utf8').catch(() => '');
  const lines = text.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    const parsed = LogLineSchema.safeParse(parseJson(line));
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
