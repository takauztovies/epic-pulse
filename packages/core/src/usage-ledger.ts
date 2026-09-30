import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFile, errnoOf } from './atomic.js';
import { acquireLock, releaseLock, type Lock } from './lock.js';
import { BUDGET_WINDOW_MS, HOURLY_BUDGET_POINTS } from './refresh-plan.js';
import { readTail } from './registry.js';
import { parseJson } from './result.js';
import { UsageLineSchema, type UsageLine } from './schemas/usage.js';

// GitHub's limit belongs to the user, not to a repository. The snapshot's
// budget is per repository, so ten repositories could each spend the whole
// hour. Every refresher on the machine therefore also charges this ledger in
// the user's cache directory: JSONL, one line per request, and every write
// drops the lines that have left the hour.

export const USAGE_FILE = 'usage.jsonl';
const LOCK_FILE = 'usage.lock';
// The lock covers one small read and one small write, so a holder this old
// died. A busy lock is retried a few times, then the charge is refused.
const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 5;
const LOCK_PAUSE_MS = 20;

export interface UsageLedger {
  readonly file: string;
  readonly lockFile: string;
  // The registry this refresher serves, as a hash of its directory.
  readonly repo: string;
}

// What a refresher charges; the ledger adds its own `repo`.
export type UsageCharge = Omit<UsageLine, 'repo'>;

export interface Reservation {
  readonly granted: boolean;
  // The hour's points across every repository, this charge included when it
  // was granted. Undefined when the ledger could not be read.
  readonly spent: number | undefined;
  readonly detail: 'ledger' | null;
}

export function usageLedgerFor(cacheDir: string, registryDir: string): UsageLedger {
  const repo = createHash('sha256').update(resolve(registryDir)).digest('hex').slice(0, 16);
  return { file: join(cacheDir, USAGE_FILE), lockFile: join(cacheDir, LOCK_FILE), repo };
}

// Within an hour either way. A line further ahead means the clock moved back,
// so it is dropped rather than trusted, like a usage window that starts in the
// future (refresh-plan.ts).
function inWindow(line: UsageLine, now: number): boolean {
  return Math.abs(now - line.ts) < BUDGET_WINDOW_MS;
}

function total(lines: readonly UsageLine[]): number {
  return lines.reduce((sum, line) => sum + line.points, 0);
}

export function spentIn(lines: readonly UsageLine[], now: number): number {
  return total(lines.filter((line) => inWindow(line, now)));
}

// A torn tail (a writer killed mid-write), a hand edit or a line from a newer
// version is skipped; every other line still counts.
export function parseUsage(text: string): readonly UsageLine[] {
  return text.split('\n').flatMap((raw) => {
    const parsed = UsageLineSchema.safeParse(parseJson(raw));
    return parsed.success ? [parsed.data] : [];
  });
}

// For the decisions a run makes up front: a missing or unreadable ledger reads
// as empty, because the locked check before each request still has the say.
export async function readUsage(file: string): Promise<readonly UsageLine[]> {
  return parseUsage(await readTail(file).catch(() => ''));
}

// Spreads the hour's spend instead of front-loading it: a repository may
// refresh again once the points of its last refresh are paid off at its share
// of the budget, lastCost x 3600 / budget seconds times the repositories that
// spent in the hour. Every line of one refresh carries that refresh's `ts`.
export function pacingDelay(lines: readonly UsageLine[], repo: string, now: number): number {
  const recent = lines.filter((line) => inWindow(line, now));
  const own = recent.filter((line) => line.repo === repo);
  if (own.length === 0) return 0;
  const last = Math.max(...own.map((line) => line.ts));
  const cost = total(own.filter((line) => line.ts === last));
  const repositories = new Set(recent.map((line) => line.repo)).size;
  return Math.max(0, last + (cost * BUDGET_WINDOW_MS * Math.max(1, repositories)) / HOURLY_BUDGET_POINTS - now);
}

async function lockLedger(ledger: UsageLedger, now: number): Promise<Lock | undefined> {
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    const lock = await acquireLock(ledger.lockFile, { now, staleMs: LOCK_STALE_MS }).catch(() => undefined);
    if (lock) return lock;
    if (attempt < LOCK_ATTEMPTS) await sleep(LOCK_PAUSE_MS * attempt);
  }
  return undefined;
}

// Strict where readUsage is lenient: a ledger that exists but can not be read
// must not be replaced by one holding only the new line.
async function readForWrite(file: string): Promise<readonly UsageLine[]> {
  try {
    return parseUsage(await readTail(file));
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw error;
  }
}

// Read, prune, check and write under one lock: two refreshers can not both
// take the last points of the hour, and a rewrite never drops a line another
// one just added. Anything that goes wrong refuses the charge.
async function charge(ledger: UsageLedger, entry: UsageCharge, options: { readonly now: number; readonly cap: boolean }): Promise<Reservation> {
  const lock = await lockLedger(ledger, options.now);
  if (!lock) return { granted: false, spent: undefined, detail: 'ledger' };
  try {
    const kept = (await readForWrite(ledger.file)).filter((line) => inWindow(line, options.now));
    const spent = total(kept);
    if (options.cap && spent + entry.points > HOURLY_BUDGET_POINTS) return { granted: false, spent, detail: null };
    const lines = [...kept, UsageLineSchema.parse({ ...entry, repo: ledger.repo })];
    await atomicWriteFile(ledger.file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    return { granted: true, spent: spent + entry.points, detail: null };
  } catch {
    return { granted: false, spent: undefined, detail: 'ledger' };
  } finally {
    await releaseLock(lock);
  }
}

// Before a request: granted only while the last hour of every repository plus
// this charge stays within the budget. A granted charge is written at once.
export function reserveUsage(ledger: UsageLedger, entry: UsageCharge, now: number): Promise<Reservation> {
  return charge(ledger, entry, { now, cap: true });
}

// After a request: points GitHub billed beyond the reservation. They are spent
// already, so no cap applies. False when the ledger could not be written.
export async function recordUsage(ledger: UsageLedger, entry: UsageCharge, now: number): Promise<boolean> {
  return (await charge(ledger, entry, { now, cap: false })).granted;
}
