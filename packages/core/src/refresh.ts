import { resolveToken } from './github.js';
import { acquireLock, releaseLock, type Lock } from './lock.js';
import { pathsFor, userCacheDir, type RegistryPaths } from './paths.js';
import { pinsOf, readPins } from './pins.js';
import { pruneSnapshot } from './refresh-apply.js';
import { overBudget, runBatch, type Context, type Run } from './refresh-batch.js';
import {
  chunk, epicRefsOf, epicsToWatch, gatherRefs, groupByRepo, needsFetch, needsResolution, PHASE_A_BATCH, PHASE_A_COST,
  phaseBBatchSize, pinnedRefs, rollUsage, withSession, type RepoGroup,
} from './refresh-plan.js';
import { pruneSessions, readLiveSessions, readSession, type SessionState } from './registry.js';
import { unfetchedEpics, unresolvedRefs } from './resolve.js';
import type { ErrorCode, IssueRef } from './schemas/common.js';
import { SessionIdSchema } from './schemas/hook.js';
import type { Snapshot } from './schemas/snapshot.js';
import { emptySnapshot, readSnapshot, writeSnapshot, type SnapshotRead } from './snapshot.js';
import { pacingDelay, readUsage, spentIn, usageLedgerFor, type UsageLedger } from './usage-ledger.js';

export interface RefreshOptions {
  readonly dir: string;
  readonly now: number;
  readonly env: NodeJS.ProcessEnv;
  // Tokens the caller already holds, each under the one host it belongs to.
  // A host's own entry comes before the environment and `gh`; no other host
  // ever sees it. In memory only, like every token.
  readonly tokens?: Readonly<Record<string, string>>;
}

export type RefreshOutcome =
  | { readonly status: 'busy' }
  // Held back only by pacing: nothing is wrong, cached data waits for this
  // repository's turn in the hour every refresher shares. `until` is when that
  // is, in milliseconds since the epoch.
  | { readonly status: 'paced'; readonly until: number }
  | { readonly status: 'done'; readonly requests: number; readonly points: number; readonly error: ErrorCode | null };

// The status line names its own session here when it starts a refresh.
export const REFRESH_SESSION_ENV = 'EPIC_PULSE_SESSION';

// Each request has a 15 s timeout and the lock is touched after every one, so
// a live holder is always fresh; a dead one frees the lock within a minute.
const LOCK_STALE_MS = 60_000;

// The user's hour as a run starts: the ledger, what it says was spent, and how
// long this repository still has to wait its turn (0: it does not).
interface UsageView {
  readonly ledger: UsageLedger | undefined;
  readonly spent: number;
  readonly waitMs: number;
}

// A paced run still asks for what nothing has shown yet, a ref never resolved
// or an epic never fetched: on screen those are "loading", and a new binding
// must not sit out its repository's turn (lastCost x 3600 / 300 seconds, per
// repository) before it shows. Refreshing cached data is what waits.
function toResolve(run: Run, refs: readonly IssueRef[]): readonly IssueRef[] {
  return run.paced ? unresolvedRefs(refs, run.snapshot) : needsResolution(run.snapshot, refs, run.now);
}

// A pinned issue that may be an epic itself is asked about like any cached
// data: it waits its turn, since the pin shows its parent's epic meanwhile.
function toFetch(run: Run, refs: readonly IssueRef[]): readonly IssueRef[] {
  if (run.paced) return unfetchedEpics(epicRefsOf(run.snapshot, refs), run.snapshot);
  return needsFetch(run.snapshot, epicsToWatch(run.snapshot, refs, run.pinned ?? []), run.now);
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

function pendingRefs(run: Run, refs: readonly IssueRef[]): readonly IssueRef[] {
  const { snapshot, now } = run;
  return [...needsResolution(snapshot, refs, now), ...needsFetch(snapshot, epicsToWatch(snapshot, refs, run.pinned ?? []), now)];
}

// Tokens are looked up only for hosts with work to do and only when even the
// cheapest request fits the budget, so a warm cache or a spent hour never
// spawns `gh auth token`. Epics found in Phase A share their issue's host.
// The caller's map is read through its own entries only: `constructor` is a
// valid host name, and every object inherits a value under it.
async function tokensFor(run: Run, refs: readonly IssueRef[], options: RefreshOptions): Promise<ReadonlyMap<string, string>> {
  if (overBudget(run, PHASE_A_COST)) return new Map();
  const given = new Map(Object.entries(options.tokens ?? {}));
  const hosts = [...new Set(pendingRefs(run, refs).map((ref) => ref.host))];
  const found = await Promise.all(hosts.map(async (host) => [host, given.get(host) ?? (await resolveToken(host, options.env))?.token] as const));
  return new Map(found.flatMap(([host, token]) => (token === undefined ? [] : [[host, token] as const])));
}

// Without a cache directory the hour can not be shared with the user's other
// refreshers, so it counts as spent rather than as empty.
async function openUsage(options: RefreshOptions): Promise<UsageView> {
  const cacheDir = userCacheDir(options.env);
  if (cacheDir === undefined) return { ledger: undefined, spent: Number.POSITIVE_INFINITY, waitMs: 0 };
  const ledger = usageLedgerFor(cacheDir, options.dir);
  const lines = await readUsage(ledger.file);
  return { ledger, spent: spentIn(lines, options.now), waitMs: pacingDelay(lines, ledger.repo, options.now) };
}

function startRun(before: SnapshotRead, now: number, usage: UsageView): Run {
  const snapshot = before.status === 'ok' ? before.snapshot : emptySnapshot(now);
  const rolled = { ...snapshot, usage: rollUsage(snapshot.usage, now) };
  return { now, snapshot: rolled, requests: 0, points: 0, failure: null, spent: usage.spent, paced: usage.waitMs > 0 };
}

// Work is due, and all of it is cached data that has to wait its turn.
function waitsItsTurn(run: Run, refs: readonly IssueRef[]): boolean {
  if (!run.paced || toResolve(run, refs).length > 0 || toFetch(run, refs).length > 0) return false;
  return pendingRefs(run, refs).length > 0;
}

// The session whose status line started this refresh, read whether or not it
// is live. An id that is not a Claude Code session id names none.
async function ownSession(paths: RegistryPaths, env: NodeJS.ProcessEnv): Promise<SessionState | undefined> {
  const id = SessionIdSchema.safeParse(env[REFRESH_SESSION_ENV]);
  return id.success ? readSession(paths, id.data) : undefined;
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

// A paced run whose only work is cached data says `paced`, and when its turn
// comes, to its caller and leaves the snapshot alone: waiting a turn is not a
// failure to show, and the data ages into "stale" on its own if the turn is long.
async function refreshLocked(options: RefreshOptions, lock: Lock): Promise<RefreshOutcome> {
  const { now } = options;
  const paths = pathsFor(options.dir);
  const [sessions, pins, before, usage, own] = await Promise.all([
    readLiveSessions(paths, now), readPins(paths), readSnapshot(paths.snapshotFile), openUsage(options), ownSession(paths, options.env),
  ]);
  const refs = withSession(gatherRefs(sessions, pinsOf(pins), now), own, now);
  const start = { ...startRun(before, now, usage), pinned: pinnedRefs(own ? [...sessions, own] : sessions, pinsOf(pins), now) };
  if (waitsItsTurn(start, refs)) return { status: 'paced', until: now + usage.waitMs };
  const started = performance.now();
  const clock = () => now + Math.round(performance.now() - started);
  const ctx: Context = { tokens: await tokensFor(start, refs, options), lock, clock, ledger: usage.ledger };
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
