import { describeFetchError, postGraphql, type RawResponse } from './github.js';
import { touchLock, type Lock } from './lock.js';
import { parsePhaseA, parsePhaseB, phaseADocument, phaseBDocument, type Failure, type RateInfo } from './queries.js';
import { applyEpics, applyRefusal, applyResolutions, chargePoints, chargeRate, markEpicErrors, rateLimited } from './refresh-apply.js';
import { backingOff, HOURLY_BUDGET_POINTS, PHASE_A_COST, phaseBCost } from './refresh-plan.js';
import { fail, ok, type Result } from './result.js';
import type { ErrorCode, IssueRef, RepoRef } from './schemas/common.js';
import type { Snapshot } from './schemas/snapshot.js';
import { recordUsage, reserveUsage, type UsageLedger } from './usage-ledger.js';

// One refresh in progress. `now` is the run's single timestamp: every entry
// it writes is stamped with it. `spent` is what every refresher of the user
// spent in the last hour, as the usage ledger last said; absent, only this
// repository's own budget applies. `paced`: the repository has not paid off
// its last refresh yet, so only what was never fetched may go out.
export interface Run {
  readonly now: number;
  readonly snapshot: Snapshot;
  readonly requests: number;
  readonly points: number;
  readonly failure: Failure | null;
  readonly spent?: number;
  readonly paced?: boolean;
}

// Tokens live here, in memory, for one run; nothing in `Run` or the snapshot
// has a field that could hold one. Without a ledger no request is charged
// to the user's hour.
export interface Context {
  readonly tokens: ReadonlyMap<string, string>;
  readonly lock: Lock;
  readonly clock: () => number;
  readonly ledger?: UsageLedger;
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

// This repository's hour, the token's own limit, and the user's hour as the
// ledger last reported it. In memory only: the locked check in `reserve` is
// the one that counts.
export function overBudget(run: Run, cost: number): boolean {
  return blocked(run.snapshot, cost, run.now) || (run.spent ?? 0) + cost > HOURLY_BUDGET_POINTS;
}

// The budget is checked before the token, so a spent hour reads as "budget"
// even where the token is missing too.
function admit(run: Run, batch: Batch, ctx: Context): Result<string, Failure> {
  if (overBudget(run, costOf(batch))) return fail({ code: 'budget', detail: null });
  const token = ctx.tokens.get(batch.repo.host);
  return token === undefined ? fail({ code: 'no_token', detail: null }) : ok(token);
}

// The charge goes into the user's ledger before the request is sent, and only
// if the hour still has room for it, so two refreshers of different
// repositories can not both take the last points.
async function reserve(run: Run, batch: Batch, ctx: Context): Promise<{ readonly run: Run; readonly failure: Failure | null }> {
  if (!ctx.ledger) return { run, failure: null };
  const outcome = await reserveUsage(ctx.ledger, { ts: run.now, host: batch.repo.host, points: costOf(batch) }, ctx.clock());
  const next = { ...run, spent: outcome.spent ?? run.spent };
  return { run: next, failure: outcome.granted ? null : { code: 'budget', detail: outcome.detail } };
}

// GitHub bills what it bills. A reservation below the charged cost is topped
// up; one above it stands, since over-counting only slows us down.
async function topUp(run: Run, extra: { readonly host: string; readonly points: number }, ctx: Context): Promise<Run> {
  if (!ctx.ledger || extra.points <= 0) return run;
  await recordUsage(ctx.ledger, { ts: run.now, ...extra }, ctx.clock());
  return { ...run, spent: (run.spent ?? 0) + extra.points };
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

// The answers asking again would not change: this repository's issues can
// not be read with this token, or the host has no sub-issues.
const PERMANENT: ReadonlySet<ErrorCode> = new Set(['not_found', 'forbidden', 'unsupported']);
// Stops that say nothing about the epics. The snapshot is shared, so a
// refresher without a token must leave alone what one with a token (a VS Code
// sign-in) fetched; the snapshot's own error still says why it got nothing.
const UNMARKED: ReadonlySet<ErrorCode> = new Set(['budget', 'no_token']);

// A budget stop or a missing token marks nothing: the data is not wrong, only
// not refreshed, and ages into "stale" on its own. Every other Phase B failure
// marks the epics it hit. A Phase A failure that is permanent is cached as a
// resolution; any other is simply asked again on the next run.
function noted(run: Run, batch: Batch, code: ErrorCode): Snapshot {
  if (batch.phase === 'A') return PERMANENT.has(code) ? applyRefusal(run.snapshot, batch.refs, { code, now: run.now }) : run.snapshot;
  return UNMARKED.has(code) ? run.snapshot : markEpicErrors(run.snapshot, batch.refs, code);
}

function failed(run: Run, batch: Batch, failure: Failure): Run {
  return { ...run, snapshot: noted(run, batch, failure.code), failure: run.failure ?? failure };
}

// GitHub answered but refused, or the shape was wrong. Whether it billed the
// query is unknown, so the estimate is charged: over-counting only slows us.
function rejected(run: Run, batch: Batch, failure: Failure): Run {
  const limited = failure.code === 'rate_limited' ? rateLimited(run.snapshot, run.now) : run.snapshot;
  const charged = { ...run, snapshot: chargePoints(limited, costOf(batch)), points: run.points + costOf(batch) };
  return failed(charged, batch, failure);
}

// GitHub says what the query cost and what is left of the token's hour. A
// server that says neither (rate limiting turned off) is charged the
// estimate, never nothing, and the limit last seen stands.
function charged(run: Run, batch: Batch, answer: { readonly rate: RateInfo | null; readonly snapshot: Snapshot }): Run {
  const { rate, snapshot } = answer;
  if (rate === null) return { ...run, snapshot: chargePoints(snapshot, costOf(batch)), points: run.points + costOf(batch) };
  return { ...run, snapshot: chargeRate(snapshot, rate), points: run.points + rate.cost };
}

export function answered(run: Run, batch: Batch, res: RawResponse): Run {
  if (batch.phase === 'A') {
    const parsed = parsePhaseA(res);
    if (!parsed.ok) return rejected(run, batch, parsed.error);
    const answers = batch.refs.map((ref) => [ref, parsed.value.issues.get(ref.number) ?? null] as const);
    return charged(run, batch, { rate: parsed.value.rate, snapshot: applyResolutions(run.snapshot, answers, run.now) });
  }
  const parsed = parsePhaseB(res);
  if (!parsed.ok) return rejected(run, batch, parsed.error);
  const answers = batch.refs.map((ref) => [ref, parsed.value.epics.get(ref.number) ?? null] as const);
  return charged(run, batch, { rate: parsed.value.rate, snapshot: applyEpics(run.snapshot, answers, run.now) });
}

export async function runBatch(run: Run, batch: Batch, ctx: Context): Promise<Run> {
  const token = admit(run, batch, ctx);
  if (!token.ok) return failed(run, batch, token.error);
  const reserved = await reserve(run, batch, ctx);
  if (reserved.failure) return failed(reserved.run, batch, reserved.failure);
  const sent = await send(token.value, batch);
  await touchLock(ctx.lock, ctx.clock());
  const counted = { ...reserved.run, requests: reserved.run.requests + 1 };
  const next = sent.ok ? answered(counted, batch, sent.value) : failed(counted, batch, sent.error);
  return topUp(next, { host: batch.repo.host, points: next.points - counted.points - costOf(batch) }, ctx);
}
