import { resolveToken } from './github.js';
import { acquireLock, releaseLock, type Lock } from './lock.js';
import { pathsFor } from './paths.js';
import { pinsOf, readPins } from './pins.js';
import { pruneSnapshot } from './refresh-apply.js';
import { blocked, runBatch, type Context, type Run } from './refresh-batch.js';
import {
  chunk, epicRefsOf, gatherRefs, groupByRepo, needsFetch, needsResolution, PHASE_A_BATCH, PHASE_A_COST,
  phaseBBatchSize, rollUsage, type RepoGroup,
} from './refresh-plan.js';
import { pruneSessions, readLiveSessions } from './registry.js';
import type { ErrorCode, IssueRef } from './schemas/common.js';
import type { Snapshot } from './schemas/snapshot.js';
import { emptySnapshot, readSnapshot, writeSnapshot, type SnapshotRead } from './snapshot.js';

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

async function runPhaseA(run: Run, refs: readonly IssueRef[], ctx: Context): Promise<Run> {
  let current = run;
  for (const group of groupByRepo(needsResolution(run.snapshot, refs, run.now))) {
    for (const part of chunk(group.refs, PHASE_A_BATCH)) current = await runBatch(current, { phase: 'A', repo: group.repo, refs: part }, ctx);
  }
  return current;
}

// Batches shrink to what the remaining budget allows, oldest epics first.
async function fetchGroup(run: Run, group: RepoGroup, ctx: Context): Promise<Run> {
  let current = run;
  for (let rest = group.refs; rest.length > 0; ) {
    const size = Math.max(1, phaseBBatchSize(current.snapshot.usage));
    current = await runBatch(current, { phase: 'B', repo: group.repo, refs: rest.slice(0, size) }, ctx);
    rest = rest.slice(size);
  }
  return current;
}

async function runPhaseB(run: Run, refs: readonly IssueRef[], ctx: Context): Promise<Run> {
  let current = run;
  for (const group of groupByRepo(needsFetch(run.snapshot, epicRefsOf(run.snapshot, refs), run.now))) {
    current = await fetchGroup(current, group, ctx);
  }
  return current;
}

// Tokens are looked up only for hosts with work to do and only when even the
// cheapest request fits the budget, so a warm cache or a spent hour never
// spawns `gh auth token`. Epics found in Phase A share their issue's host.
async function tokensFor(run: Run, refs: readonly IssueRef[], env: NodeJS.ProcessEnv): Promise<ReadonlyMap<string, string>> {
  const { snapshot, now } = run;
  if (blocked(snapshot, PHASE_A_COST, now)) return new Map();
  const pending = [...needsResolution(snapshot, refs, now), ...needsFetch(snapshot, epicRefsOf(snapshot, refs), now)];
  const hosts = [...new Set(pending.map((ref) => ref.host))];
  const found = await Promise.all(hosts.map(async (host) => [host, (await resolveToken(host, env))?.token] as const));
  return new Map(found.flatMap(([host, token]) => (token === undefined ? [] : [[host, token] as const])));
}

function startRun(before: SnapshotRead, now: number): Run {
  const snapshot = before.status === 'ok' ? before.snapshot : emptySnapshot(now);
  return { now, snapshot: { ...snapshot, usage: rollUsage(snapshot.usage, now) }, requests: 0, points: 0, failure: null };
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

async function refreshLocked(options: RefreshOptions, lock: Lock): Promise<RefreshOutcome> {
  const { now } = options;
  const paths = pathsFor(options.dir);
  const [sessions, pins, before] = await Promise.all([readLiveSessions(paths, now), readPins(paths), readSnapshot(paths.snapshotFile)]);
  const refs = gatherRefs(sessions, pinsOf(pins), now);
  const start = startRun(before, now);
  const started = performance.now();
  const clock = () => now + Math.round(performance.now() - started);
  const ctx: Context = { tokens: await tokensFor(start, refs, options.env), lock, clock };
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
