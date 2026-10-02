import { resolveToken } from './github.js';
import { acquireLock, releaseLock, type Lock } from './lock.js';
import { pathsFor, userCacheDir } from './paths.js';
import { pinsOf, readPins } from './pins.js';
import { pruneSnapshot } from './refresh-apply.js';
import { overBudget, runBatch, type Context, type Run } from './refresh-batch.js';
import {
  chunk, epicRefsOf, gatherRefs, groupByRepo, needsFetch, needsResolution, PHASE_A_BATCH, PHASE_A_COST,
  phaseBBatchSize, rollUsage, type RepoGroup,
} from './refresh-plan.js';
import { pruneSessions, readLiveSessions } from './registry.js';
import { unfetchedEpics, unresolvedRefs } from './resolve.js';
import type { ErrorCode, IssueRef } from './schemas/common.js';
import type { Snapshot } from './schemas/snapshot.js';
import { emptySnapshot, readSnapshot, writeSnapshot, type SnapshotRead } from './snapshot.js';
import { pacingDelay, readUsage, spentIn, usageLedgerFor, type UsageLedger } from './usage-ledger.js';

export interface RefreshOptions {
  readonly dir: string;
  readonly now: number;
  readonly env: NodeJS.ProcessEnv;
}

export type RefreshOutcome =
  | { readonly status: 'busy' }
  | { readonly status: 'done'; readonly requests: number; readonly points: number; readonly error: ErrorCode | null };

// Each request has a 15 s timeout and the lock is touched after every one, so
// a live holder is always fresh; a dead one frees the lock within a minute.
const LOCK_STALE_MS = 60_000;

// The user's hour as a run starts: the ledger, what it says was spent, and
// whether this repository still has to wait its turn.
interface UsageView {
  readonly ledger: UsageLedger | undefined;
  readonly spent: number;
  readonly paced: boolean;
}

// A paced run still asks for what nothing has shown yet, a ref never resolved
// or an epic never fetched: on screen those are "loading", and a new binding
// must not sit out its repository's turn (lastCost x 3600 / 300 seconds, per
// repository) before it shows. Refreshing cached data is what waits.
function toResolve(run: Run, refs: readonly IssueRef[]): readonly IssueRef[] {
  return run.paced ? unresolvedRefs(refs, run.snapshot) : needsResolution(run.snapshot, refs, run.now);
}

function toFetch(run: Run, refs: readonly IssueRef[]): readonly IssueRef[] {
  const epics = epicRefsOf(run.snapshot, refs);
  return run.paced ? unfetchedEpics(epics, run.snapshot) : needsFetch(run.snapshot, epics, run.now);
}

async function runPhaseA(run: Run, refs: readonly IssueRef[], ctx: Context): Promise<Run> {
  let current = run;
  for (const group of groupByRepo(toResolve(run, refs))) {
    for (const part of chunk(group.refs, PHASE_A_BATCH)) current = await runBatch(current, { phase: 'A', repo: group.repo, refs: part }, ctx);
  }
  return current;
}

// Batches shrink to what the remaining budget allows, oldest epics first: the
// smaller of this repository's hour and the user's.
async function fetchGroup(run: Run, group: RepoGroup, ctx: Context): Promise<Run> {
  let current = run;
  for (let rest = group.refs; rest.length > 0; ) {
    const usage = current.snapshot.usage;
    const size = Math.max(1, phaseBBatchSize({ ...usage, points: Math.max(usage.points, current.spent ?? 0) }));
    current = await runBatch(current, { phase: 'B', repo: group.repo, refs: rest.slice(0, size) }, ctx);
    rest = rest.slice(size);
  }
  return current;
}

async function runPhaseB(run: Run, refs: readonly IssueRef[], ctx: Context): Promise<Run> {
  let current = run;
  for (const group of groupByRepo(toFetch(run, refs))) {
    current = await fetchGroup(current, group, ctx);
  }
  return current;
}

function pendingRefs(snapshot: Snapshot, refs: readonly IssueRef[], now: number): readonly IssueRef[] {
  return [...needsResolution(snapshot, refs, now), ...needsFetch(snapshot, epicRefsOf(snapshot, refs), now)];
}

// Tokens are looked up only for hosts with work to do and only when even the
// cheapest request fits the budget, so a warm cache or a spent hour never
// spawns `gh auth token`. Epics found in Phase A share their issue's host.
async function tokensFor(run: Run, refs: readonly IssueRef[], env: NodeJS.ProcessEnv): Promise<ReadonlyMap<string, string>> {
  if (overBudget(run, PHASE_A_COST)) return new Map();
  const hosts = [...new Set(pendingRefs(run.snapshot, refs, run.now).map((ref) => ref.host))];
  const found = await Promise.all(hosts.map(async (host) => [host, (await resolveToken(host, env))?.token] as const));
  return new Map(found.flatMap(([host, token]) => (token === undefined ? [] : [[host, token] as const])));
}

// Without a cache directory the hour can not be shared with the user's other
// refreshers, so it counts as spent rather than as empty.
async function openUsage(options: RefreshOptions): Promise<UsageView> {
  const cacheDir = userCacheDir(options.env);
  if (cacheDir === undefined) return { ledger: undefined, spent: Number.POSITIVE_INFINITY, paced: false };
  const ledger = usageLedgerFor(cacheDir, options.dir);
  const lines = await readUsage(ledger.file);
  return { ledger, spent: spentIn(lines, options.now), paced: pacingDelay(lines, ledger.repo, options.now) > 0 };
}

function startRun(before: SnapshotRead, now: number, usage: UsageView): Run {
  const snapshot = before.status === 'ok' ? before.snapshot : emptySnapshot(now);
  const rolled = { ...snapshot, usage: rollUsage(snapshot.usage, now) };
  return { now, snapshot: rolled, requests: 0, points: 0, failure: null, spent: usage.spent, paced: usage.paced };
}

// Work is due, and all of it is cached data that has to wait its turn.
function waitsItsTurn(run: Run, refs: readonly IssueRef[]): boolean {
  if (!run.paced || toResolve(run, refs).length > 0 || toFetch(run, refs).length > 0) return false;
  return pendingRefs(run.snapshot, refs, run.now).length > 0;
}

// Errors are stored as a code plus a whitelisted detail, never as text.
function finalSnapshot(run: Run, refs: readonly IssueRef[]): Snapshot {
  const pruned = pruneSnapshot(run.snapshot, refs, run.now);
  return { ...pruned, error: run.failure?.code ?? null, detail: run.failure?.detail?.slice(0, 120) ?? null };
}

// Rewritten when a request was made or anything changed; a run that found
// everything fresh leaves the file, and its mtime, alone.
function unchanged(before: SnapshotRead, next: Snapshot, refs: readonly IssueRef[]): boolean {
  if (before.status === 'missing') return refs.length === 0;
  return before.status === 'ok' && JSON.stringify({ ...before.snapshot, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 });
}

// A paced run whose only work is cached data says `budget` to its caller but
// leaves the snapshot alone: waiting a turn is not a failure to show, and the
// data ages into "stale" on its own if the turn is long.
async function refreshLocked(options: RefreshOptions, lock: Lock): Promise<RefreshOutcome> {
  const { now } = options;
  const paths = pathsFor(options.dir);
  const [sessions, pins, before, usage] = await Promise.all([
    readLiveSessions(paths, now), readPins(paths), readSnapshot(paths.snapshotFile), openUsage(options),
  ]);
  const refs = gatherRefs(sessions, pinsOf(pins), now);
  const start = startRun(before, now, usage);
  if (waitsItsTurn(start, refs)) return { status: 'done', requests: 0, points: 0, error: 'budget' };
  const started = performance.now();
  const clock = () => now + Math.round(performance.now() - started);
  const ctx: Context = { tokens: await tokensFor(start, refs, options.env), lock, clock, ledger: usage.ledger };
  const run = await runPhaseB(await runPhaseA(start, refs, ctx), refs, ctx);
  const next = finalSnapshot(run, refs);
  if (run.requests > 0 || !unchanged(before, next, refs)) await writeSnapshot(paths.snapshotFile, { ...next, updatedAt: now });
  await pruneSessions(paths, now);
  return { status: 'done', requests: run.requests, points: run.points, error: run.failure?.code ?? null };
}

// Single-flight: a refresher that finds the lock held leaves at once. Throws
// only when the registry directory itself can not be written.
export async function refresh(options: RefreshOptions): Promise<RefreshOutcome> {
  const lock = await acquireLock(pathsFor(options.dir).lockFile, { now: options.now, staleMs: LOCK_STALE_MS });
  if (!lock) return { status: 'busy' };
  try {
    return await refreshLocked(options, lock);
  } finally {
    await releaseLock(lock);
  }
}
