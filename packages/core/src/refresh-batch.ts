import { describeFetchError, postGraphql, type RawResponse } from './github.js';
import { touchLock, type Lock } from './lock.js';
import { parsePhaseA, parsePhaseB, phaseADocument, phaseBDocument, type Failure, type RateInfo } from './queries.js';
import { applyEpics, applyResolutions, chargePoints, chargeRate, markEpicErrors, rateLimited } from './refresh-apply.js';
import { backingOff, HOURLY_BUDGET_POINTS, PHASE_A_COST, phaseBCost } from './refresh-plan.js';
import { fail, ok, type Result } from './result.js';
import type { ErrorCode, IssueRef, RepoRef } from './schemas/common.js';
import type { Snapshot } from './schemas/snapshot.js';

// One refresh in progress. `now` is the run's single timestamp: every entry
// it writes is stamped with it.
export interface Run {
  readonly now: number;
  readonly snapshot: Snapshot;
  readonly requests: number;
  readonly points: number;
  readonly failure: Failure | null;
}

// Tokens live here, in memory, for one run; nothing in `Run` or the snapshot
// has a field that could hold one.
export interface Context {
  readonly tokens: ReadonlyMap<string, string>;
  readonly lock: Lock;
  readonly clock: () => number;
}

export interface Batch {
  readonly phase: 'A' | 'B';
  readonly repo: RepoRef;
  readonly refs: readonly IssueRef[];
}

function costOf(batch: Batch): number {
  return batch.phase === 'A' ? PHASE_A_COST : phaseBCost(batch.refs.length);
}

export function blocked(snapshot: Snapshot, cost: number, now: number): boolean {
  return snapshot.usage.points + cost > HOURLY_BUDGET_POINTS || backingOff(snapshot.rateLimit, now);
}

// The budget is checked before the token, so a spent hour reads as "budget"
// even where the token is missing too.
function admit(run: Run, batch: Batch, ctx: Context): Result<string, ErrorCode> {
  if (blocked(run.snapshot, costOf(batch), run.now)) return fail('budget');
  const token = ctx.tokens.get(batch.repo.host);
  return token === undefined ? fail('no_token') : ok(token);
}

// The only network call. A thrown error goes through describeFetchError's
// whitelist, never into a message: undici echoes a malformed header value,
// token included, in its error text.
async function send(token: string, batch: Batch): Promise<Result<RawResponse, Failure>> {
  const numbers = batch.refs.map((ref) => ref.number);
  const query = batch.phase === 'A' ? phaseADocument(numbers) : phaseBDocument(numbers);
  try {
    return ok(await postGraphql({ host: batch.repo.host, token, query, variables: { owner: batch.repo.owner, name: batch.repo.repo } }));
  } catch (error) {
    return fail(describeFetchError(error));
  }
}

// A budget stop marks nothing: the data is not wrong, only not refreshed, and
// ages into "stale" on its own. Every other failure marks the epics it hit.
function failed(run: Run, batch: Batch, failure: Failure): Run {
  const hit = batch.phase === 'B' && failure.code !== 'budget';
  const snapshot = hit ? markEpicErrors(run.snapshot, batch.refs, failure.code) : run.snapshot;
  return { ...run, snapshot, failure: run.failure ?? failure };
}

// GitHub answered but refused, or the shape was wrong. Whether it billed the
// query is unknown, so the estimate is charged: over-counting only slows us.
function rejected(run: Run, batch: Batch, failure: Failure): Run {
  const limited = failure.code === 'rate_limited' ? rateLimited(run.snapshot, run.now) : run.snapshot;
  const charged = { ...run, snapshot: chargePoints(limited, costOf(batch)), points: run.points + costOf(batch) };
  return failed(charged, batch, failure);
}

function charged(run: Run, rate: RateInfo, snapshot: Snapshot): Run {
  return { ...run, snapshot: chargeRate(snapshot, rate), points: run.points + rate.cost };
}

function answered(run: Run, batch: Batch, res: RawResponse): Run {
  if (batch.phase === 'A') {
    const parsed = parsePhaseA(res);
    if (!parsed.ok) return rejected(run, batch, parsed.error);
    const answers = batch.refs.map((ref) => [ref, parsed.value.issues.get(ref.number) ?? null] as const);
    return charged(run, parsed.value.rate, applyResolutions(run.snapshot, answers, run.now));
  }
  const parsed = parsePhaseB(res);
  if (!parsed.ok) return rejected(run, batch, parsed.error);
  const answers = batch.refs.map((ref) => [ref, parsed.value.epics.get(ref.number) ?? null] as const);
  return charged(run, parsed.value.rate, applyEpics(run.snapshot, answers, run.now));
}

export async function runBatch(run: Run, batch: Batch, ctx: Context): Promise<Run> {
  const token = admit(run, batch, ctx);
  if (!token.ok) return failed(run, batch, { code: token.error, detail: null });
  const sent = await send(token.value, batch);
  await touchLock(ctx.lock, ctx.clock());
  const counted = { ...run, requests: run.requests + 1 };
  return sent.ok ? answered(counted, batch, sent.value) : failed(counted, batch, sent.error);
}
