import { refKey, repoKey } from './ref.js';
import { activeBindings, isLive, type SessionState } from './registry.js';
import type { IssueRef, RepoRef } from './schemas/common.js';
import type { Pin } from './schemas/registry.js';
import type { Snapshot } from './schemas/snapshot.js';
import { descendantEpics, subEpicKeys } from './tree.js';

// Phase A answers "which epic is this issue in", which rarely changes. Phase B
// fetches the epic's children, which is what moves while people work.
export const RESOLUTION_TTL_MS = 30 * 60 * 1000;
export const EPIC_TTL_MS = 2 * 60 * 1000;
// An epic below another one is refreshed less often: a tree of many sub-epics at
// the top epic's pace would spend the hourly budget (300 points) in minutes.
export const SUB_EPIC_TTL_MS = 6 * 60 * 1000;
// Our own ceiling, far below GitHub's 5,000 an hour, so the user's other tools
// keep theirs. Every session of a repository shares it through the snapshot,
// and every repository of the user through the usage ledger (usage-ledger.ts).
export const HOURLY_BUDGET_POINTS = 300;
export const BUDGET_WINDOW_MS = 60 * 60 * 1000;
// With fewer points than this left on the token, wait for GitHub's reset.
export const MIN_REMAINING_POINTS = 1000;
// How long to stay away after GitHub itself answered "rate limited".
export const RATE_LIMITED_BACKOFF_MS = 5 * 60 * 1000;
// Unreferenced entries are kept this long, so a session that went quiet still
// finds its epic (shown stale) instead of "loading" when it comes back.
export const RETAIN_MS = 6 * 60 * 60 * 1000;
export const PHASE_A_BATCH = 50;
export const PHASE_A_COST = 1;
const PHASE_B_BATCH = 10;

export interface RepoGroup {
  readonly repo: RepoRef;
  readonly refs: readonly IssueRef[];
}

type Usage = Snapshot['usage'];

function unique(refs: readonly IssueRef[]): readonly IssueRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref] as const)).values()];
}

// What the refresher keeps current: the active bindings of live sessions, then
// the repository's pins.
export function gatherRefs(sessions: readonly SessionState[], pins: readonly Pin[], now: number): readonly IssueRef[] {
  const bound = sessions.filter((session) => isLive(session, now)).flatMap((session) => activeBindings(session, now));
  return unique([...bound.map((binding) => binding.ref), ...pins.map((pin) => pin.ref)]);
}

// The issues the user named on purpose: a session's pins, which last until they
// are untracked, and the repository's pins. Pass the live sessions, and the
// status line's own session too, as withSession does.
export function pinnedRefs(sessions: readonly SessionState[], pins: readonly Pin[], now: number): readonly IssueRef[] {
  const bound = sessions.flatMap((session) => activeBindings(session, now)).filter((binding) => binding.via === 'pin');
  return unique([...bound.map((binding) => binding.ref), ...pins.map((pin) => pin.ref)]);
}

// The status line shows its own session's bindings however long the session
// has been quiet, so those count whether or not it is live, first.
export function withSession(refs: readonly IssueRef[], session: SessionState | undefined, now: number): readonly IssueRef[] {
  if (session === undefined) return refs;
  return unique([...activeBindings(session, now).map((binding) => binding.ref), ...refs]);
}

export function groupByRepo(refs: readonly IssueRef[]): readonly RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const ref of refs) {
    const group = groups.get(repoKey(ref));
    const repo = group?.repo ?? { host: ref.host, owner: ref.owner, repo: ref.repo };
    groups.set(repoKey(ref), { repo, refs: [...(group?.refs ?? []), ref] });
  }
  return [...groups.values()];
}

export function needsResolution(snapshot: Snapshot, refs: readonly IssueRef[], now: number): readonly IssueRef[] {
  return refs.filter((ref) => {
    const resolution = snapshot.issues[refKey(ref)];
    return resolution === undefined || now - resolution.resolvedAt >= RESOLUTION_TTL_MS;
  });
}

// The distinct epics the refs resolved to; refs with no epic, or none yet, add nothing.
export function epicRefsOf(snapshot: Snapshot, refs: readonly IssueRef[]): readonly IssueRef[] {
  return unique(refs.flatMap((ref) => snapshot.issues[refKey(ref)]?.epic ?? []));
}

// An issue with a parent resolves to the parent, which is right for work bound
// to it and wrong for a pin, which names the issue: if that is an epic itself
// (a sub-epic) it shows as that. Phase B has to look at it to know, so a pinned
// issue whose resolution points at a parent is asked about as an epic of its
// own, unless it was found not to be one, which holds until Phase A asks again.
export function probeTargets(snapshot: Snapshot, pinned: readonly IssueRef[]): readonly IssueRef[] {
  return unique(pinned.filter((ref) => {
    const resolution = snapshot.issues[refKey(ref)];
    return resolution?.epic != null && refKey(resolution.epic) !== refKey(ref) && resolution.isEpic !== false;
  }));
}

// What Phase B keeps current: the epics the refs resolved to, then the pinned
// issues that may be epics themselves.
export function epicsToWatch(snapshot: Snapshot, refs: readonly IssueRef[], pinned: readonly IssueRef[]): readonly IssueRef[] {
  const top = unique([...epicRefsOf(snapshot, refs), ...probeTargets(snapshot, pinned)]);
  return unique([...top, ...descendantEpics(snapshot, top)]);
}

// Oldest first, so a tight budget refreshes whatever has waited longest.
export function needsFetch(snapshot: Snapshot, epics: readonly IssueRef[], now: number): readonly IssueRef[] {
  const fetchedAt = (epic: IssueRef) => snapshot.epics[refKey(epic)]?.fetchedAt ?? Number.NEGATIVE_INFINITY;
  const subs = subEpicKeys(snapshot);
  const ttl = (epic: IssueRef) => (subs.has(refKey(epic)) ? SUB_EPIC_TTL_MS : EPIC_TTL_MS);
  return epics.filter((epic) => now - fetchedAt(epic) >= ttl(epic)).sort((a, b) => fetchedAt(a) - fetchedAt(b));
}

// GitHub's formula for the Phase B document: each epic asks for 100 sub-issues
// with five nested connections each (the sub-issue count is one), 501 requests; the total over 100,
// rounded, is the cost, and it is never below 1. The fixtures were recorded
// before labels were asked for and say 3; the live document costs 5.
// The repository's open pull requests (queries.ts OPEN_PRS), once per request: a
// connection with nothing nested in it is one request to GitHub, not 100, so it is
// absorbed by the rounding (measured live: 5, 10 and 15 points for 1, 2 and 3 epics).
const OPEN_PR_REQUESTS = 1;

export function phaseBCost(epics: number): number {
  return Math.max(1, Math.round((epics * 501 + OPEN_PR_REQUESTS) / 100));
}

// How many epics the next Phase B request may carry within the hourly budget.
export function phaseBBatchSize(usage: Usage): number {
  let size = 0;
  while (size < PHASE_B_BATCH && usage.points + phaseBCost(size + 1) <= HOURLY_BUDGET_POINTS) size += 1;
  return size;
}

// A fixed hourly window. One that starts in the future (a clock that moved
// back, a snapshot from another machine) is restarted rather than trusted.
export function rollUsage(usage: Usage, now: number): Usage {
  const expired = now - usage.windowStart >= BUDGET_WINDOW_MS || now < usage.windowStart;
  return expired ? { windowStart: now, points: 0 } : usage;
}

export function backingOff(rateLimit: Snapshot['rateLimit'], now: number): boolean {
  return rateLimit !== null && rateLimit.remaining < MIN_REMAINING_POINTS && now < rateLimit.resetAt;
}

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
