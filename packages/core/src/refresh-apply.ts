import type { RateInfo } from './queries.js';
import { refKey } from './ref.js';
import { RATE_LIMITED_BACKOFF_MS, RETAIN_MS } from './refresh-plan.js';
import { buildEpic, epicRefFor, type EpicData } from './resolve.js';
import type { ErrorCode, IssueRef } from './schemas/common.js';
import type { EpicNode, PhaseAIssue } from './schemas/graphql.js';
import type { EpicEntry, Resolution, Snapshot } from './schemas/snapshot.js';

// Pure snapshot transitions. Each returns a new snapshot; the refresher
// decides which ones to apply and in what order.

export function applyResolutions(
  snapshot: Snapshot,
  answers: readonly (readonly [IssueRef, PhaseAIssue | null])[],
  now: number,
): Snapshot {
  const resolved = answers.map(([ref, node]) => [refKey(ref), { epic: epicRefFor(ref, node), resolvedAt: now }] as const);
  return { ...snapshot, issues: { ...snapshot.issues, ...Object.fromEntries(resolved) } };
}

// Phase A refused for good (not found, forbidden, unsupported): each issue
// resolves to no epic, with the code, so the 30-minute resolution cache keeps
// the request from being sent, and charged, on every run.
export function applyRefusal(snapshot: Snapshot, refs: readonly IssueRef[], refusal: { readonly code: ErrorCode; readonly now: number }): Snapshot {
  const refused = refs.map((ref) => [refKey(ref), { epic: null, resolvedAt: refusal.now, error: refusal.code }] as const);
  return { ...snapshot, issues: { ...snapshot.issues, ...Object.fromEntries(refused) } };
}

// An answer about an issue whose own resolution names another epic, its
// parent, says whether the issue is an epic itself: Phase B asks that of a pin
// (probeTargets). An issue that resolves to itself needs no such answer.
function withOwnAnswer(key: string, resolution: Resolution, answered: ReadonlyMap<string, boolean>): Resolution {
  const own = answered.get(key);
  if (own === undefined || resolution.epic === null || refKey(resolution.epic) === key) return resolution;
  return { ...resolution, isEpic: own };
}

// A fetched epic replaces its entry. An answer that is not an epic (not found,
// or an issue with neither sub-issues nor a checklist) removes the entry and
// re-points every issue that led to it at "no epic", which the 30-minute
// resolution cache then keeps instead of asking again every two minutes.
export function applyEpics(snapshot: Snapshot, answers: readonly (readonly [IssueRef, EpicNode | null])[], now: number): Snapshot {
  return applyBuiltEpics(snapshot, answers.map(([ref, node]) => [ref, node ? buildEpic(node, ref) : null] as const), now);
}

// The same for an epic a provider has already turned into snapshot data (Jira
// reports statuses itself, so there is no GitHub node to derive them from).
export function applyBuiltEpics(snapshot: Snapshot, answers: readonly (readonly [IssueRef, EpicData | null])[], now: number): Snapshot {
  const built = answers.map(([ref, data]) => [refKey(ref), data] as const);
  const gone = new Set(built.flatMap(([key, data]) => (data ? [] : [key])));
  const answered = new Map(built.map(([key, data]) => [key, data !== null] as const));
  const fetched = built.flatMap(([key, data]) => (data ? [[key, { ...data, fetchedAt: now, error: null }] as const] : []));
  const kept = Object.entries(snapshot.epics).filter(([key]) => !gone.has(key));
  const issues = Object.entries(snapshot.issues).map(([key, resolution]) => {
    const pointsAtGone = resolution.epic !== null && gone.has(refKey(resolution.epic));
    return [key, pointsAtGone ? { epic: null, resolvedAt: now } : withOwnAnswer(key, resolution, answered)] as const;
  });
  return { ...snapshot, epics: Object.fromEntries([...kept, ...fetched]), issues: Object.fromEntries(issues) };
}

// The data stays (it is still the best we know) and the error makes it stale.
export function markEpicErrors(snapshot: Snapshot, epics: readonly IssueRef[], code: ErrorCode): Snapshot {
  const keys = new Set(epics.map(refKey));
  const marked = Object.entries(snapshot.epics).map(([key, entry]): readonly [string, EpicEntry] => [key, keys.has(key) ? { ...entry, error: code } : entry]);
  return { ...snapshot, epics: Object.fromEntries(marked) };
}

export function chargePoints(snapshot: Snapshot, points: number): Snapshot {
  return { ...snapshot, usage: { ...snapshot.usage, points: snapshot.usage.points + points } };
}

export function chargeRate(snapshot: Snapshot, rate: RateInfo): Snapshot {
  const rateLimit = { remaining: Math.max(0, Math.trunc(rate.remaining)), resetAt: Math.max(0, Math.trunc(rate.resetAt)) };
  return { ...chargePoints(snapshot, rate.cost), rateLimit };
}

// GitHub said no without saying for how long; `backingOff` honours this.
export function rateLimited(snapshot: Snapshot, now: number): Snapshot {
  return { ...snapshot, rateLimit: { remaining: 0, resetAt: now + RATE_LIMITED_BACKOFF_MS } };
}

// Keeps what the gathered refs need plus anything resolved in the last six
// hours, and only the epics a kept issue points at, or is itself.
export function pruneSnapshot(snapshot: Snapshot, refs: readonly IssueRef[], now: number): Snapshot {
  const wanted = new Set(refs.map(refKey));
  const issues = Object.entries(snapshot.issues).filter(([key, r]) => wanted.has(key) || now - r.resolvedAt < RETAIN_MS);
  const epicKeys = new Set(issues.flatMap(([key, r]) => [...(r.epic ? [refKey(r.epic)] : []), ...(r.isEpic ? [key] : [])]));
  const epics = Object.entries(snapshot.epics).filter(([key]) => epicKeys.has(key));
  return { ...snapshot, issues: Object.fromEntries(issues), epics: Object.fromEntries(epics) };
}
