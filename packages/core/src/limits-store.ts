import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from './atomic.js';
import type { LimitsReading, LimitWarning } from './limits.js';
import { parseJson } from './result.js';
import { SessionIdSchema } from './schemas/hook.js';

// Two small files in the user's cache directory, shared by every session on the
// machine: the latest usage reading a status line saw, and which session was
// already told about which step. Percentages, times and session ids only.
export const LIMITS_FILE = 'limits.json';
export const NOTIFIED_FILE = 'limits-notified.json';
// A reading this old says nothing: no status line has rendered for ten minutes.
export const READING_FRESH_MS = 10 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const MAX_SESSIONS = 200;

const WindowSchema = z.object({ pct: z.number().min(0).max(100), resetsAt: z.number().int().nonnegative().nullable() }).nullable();
const ReadingSchema = z.object({ v: z.literal(1), at: z.number().int().nonnegative(), fiveHour: WindowSchema, sevenDay: WindowSchema });
const NoticeSchema = z.object({ band: z.number().int(), resetsAt: z.number().int().nullable(), at: z.number().int().nonnegative() });
const NotifiedSchema = z.object({ v: z.literal(1), sessions: z.record(z.string(), NoticeSchema) });

async function readJson(file: string): Promise<unknown> {
  try {
    return (await stat(file)).size > MAX_BYTES ? undefined : parseJson(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function writeLimits(cacheDir: string, reading: LimitsReading): Promise<void> {
  await atomicWriteFile(join(cacheDir, LIMITS_FILE), `${JSON.stringify(ReadingSchema.parse(reading))}\n`);
}

export async function readLimits(cacheDir: string, now: number): Promise<LimitsReading | undefined> {
  const parsed = ReadingSchema.safeParse(await readJson(join(cacheDir, LIMITS_FILE)));
  return parsed.success && now - parsed.data.at <= READING_FRESH_MS && parsed.data.at <= now + 60_000 ? parsed.data : undefined;
}

// True once per session for each step of each window period: the first call that
// sees the session past a step it was not told about claims it. Rewritten each
// time with the newest MAX_SESSIONS entries.
export async function claimNotice(cacheDir: string, sessionId: string, warning: LimitWarning & { readonly now: number }): Promise<boolean> {
  if (!SessionIdSchema.safeParse(sessionId).success) return false;
  const file = join(cacheDir, NOTIFIED_FILE);
  const parsed = NotifiedSchema.safeParse(await readJson(file));
  const sessions = parsed.success ? parsed.data.sessions : {};
  const told = sessions[sessionId];
  if (told && told.resetsAt === warning.resetsAt && told.band >= warning.band) return false;
  const next = { ...sessions, [sessionId]: { band: warning.band, resetsAt: warning.resetsAt, at: warning.now } };
  const kept = Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS);
  await atomicWriteFile(file, `${JSON.stringify({ v: 1, sessions: Object.fromEntries(kept) })}\n`);
  return true;
}
