import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, ErrorCodeSchema, parseJson, type ErrorCode } from '@epic-pulse/core';

// When the last `epic-pulse refresh` of a registry ended, and the code it
// stopped with (null: it did not). A refresh that stops before it sends
// anything, for want of a token or of budget, changes nothing the status line
// reads to decide that a refresh is due, so without this record every render
// would start one more. Written by the CLI only: a VS Code window that is
// signed out must not hold back a terminal that has a token.
export const ATTEMPT_FILE = 'refresh-attempt.json';
// How long the status line waits after a failed refresh before it starts one.
export const RETRY_AFTER_MS = 60_000;
const MAX_ATTEMPT_BYTES = 1024;

const AttemptSchema = z.object({ v: z.literal(1), at: z.number().int().nonnegative(), code: ErrorCodeSchema.nullable() }).readonly();

export type RefreshAttempt = z.infer<typeof AttemptSchema>;

// Missing, oversized or malformed reads as no record: the status line then
// behaves as it did before there was one.
export async function readAttempt(dir: string): Promise<RefreshAttempt | undefined> {
  const file = join(dir, ATTEMPT_FILE);
  try {
    if ((await stat(file)).size > MAX_ATTEMPT_BYTES) return undefined;
    const parsed = AttemptSchema.safeParse(parseJson(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function recordAttempt(dir: string, at: number, code: ErrorCode | null): Promise<void> {
  const attempt: RefreshAttempt = { v: 1, at, code };
  await atomicWriteFile(join(dir, ATTEMPT_FILE), `${JSON.stringify(AttemptSchema.parse(attempt))}\n`);
}

// A record ahead of the clock (the clock moved back) is not trusted, as a
// usage window that starts in the future is not (refresh-plan.ts).
export function retryingLater(attempt: RefreshAttempt | undefined, now: number): boolean {
  if (attempt === undefined || attempt.code === null) return false;
  return now >= attempt.at && now - attempt.at < RETRY_AFTER_MS;
}
