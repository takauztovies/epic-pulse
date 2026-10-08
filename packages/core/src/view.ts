import { makeRef, parseIssueTarget, refKey } from './ref.js';
import { activeBindings, isHookInactive, isLive, type Binding, type SessionState } from './registry.js';
import type { ErrorCode, IssueRef, StateKind } from './schemas/common.js';
import type { JsonEpic, JsonV1 } from './schemas/json-v1.js';
import type { Pin } from './schemas/registry.js';
import type { Child, EpicEntry, Snapshot } from './schemas/snapshot.js';
import type { SnapshotRead } from './snapshot.js';
import { DEFAULT_PROGRESS, type ProgressConfig } from './progress-config.js';
import type { TimeFile, TimeRef } from './schemas/time.js';
import { countStatuses, isStale, percentDone, pointsByStatus, weightedPercentDone } from './status.js';

export interface ViewInput {
  readonly snapshot: SnapshotRead;
  // Every session read from the registry; only the live ones count.
  readonly sessions: readonly SessionState[];
  readonly pins: readonly Pin[];
  readonly now: number;
  // The status line's own session (`undefined`: it has no registry line yet).
  // Without a scope the view covers every live session, which is what
  // `epic-pulse json` and the extension show.
  readonly scope?: { readonly session: SessionState | undefined };
  // What the percentages count for; the defaults when the repository sets none.
  readonly progress?: ProgressConfig;
  // What sessions have spent on each issue (time.json); none when absent.
  readonly time?: TimeFile;
}

interface Scoped {
  readonly input: ViewInput;
  readonly refs: readonly IssueRef[];
  readonly entries: readonly EpicEntry[];
  readonly snapshot: Snapshot | undefined;
}

// toISOString throws past the year 275760; a corrupt timestamp must not.
const MAX_DATE_MS = 8.64e15;

function iso(ms: number): string {
  return new Date(Math.min(ms, MAX_DATE_MS)).toISOString();
}

function ownBindings(input: ViewInput, live: readonly SessionState[]): readonly Binding[] {
  if (!input.scope) return live.flatMap((session) => activeBindings(session, input.now));
  return input.scope.session ? activeBindings(input.scope.session, input.now) : [];
}

// The scope's own bindings, most recent first, then the repository's pins.
function scopeRefs(input: ViewInput, live: readonly SessionState[]): readonly IssueRef[] {
  const own = [...ownBindings(input, live)].sort((a, b) => b.ts - a.ts).map((binding) => binding.ref);
  const pinned = [...input.pins].sort((a, b) => b.addedAt - a.addedAt).map((pin) => pin.ref);
  return [...new Map([...own, ...pinned].map((ref) => [refKey(ref), ref] as const)).values()];
}

// What a session or the repository pinned on purpose, by key.
function pinnedKeys(input: ViewInput, live: readonly SessionState[]): ReadonlySet<string> {
  const bound = ownBindings(input, live).filter((binding) => binding.via === 'pin').map((binding) => binding.ref);
  return new Set([...bound, ...input.pins.map((pin) => pin.ref)].map(refKey));
}

// An issue belongs to the epic it resolved to, its parent when it has one. A
// pin names its issue, so one that is an epic itself shows as that, whatever its
// parent: an entry exists only for a real epic.
function entryFor(ref: IssueRef, snapshot: Snapshot | undefined, pinned: ReadonlySet<string>): EpicEntry | undefined {
  const own = pinned.has(refKey(ref)) ? snapshot?.epics[refKey(ref)] : undefined;
  if (own) return own;
  const epic = snapshot?.issues[refKey(ref)]?.epic;
  return epic ? snapshot?.epics[refKey(epic)] : undefined;
}

function epicEntries(refs: readonly IssueRef[], snapshot: Snapshot | undefined, pinned: ReadonlySet<string>): readonly EpicEntry[] {
  const entries = refs.flatMap((ref) => entryFor(ref, snapshot, pinned) ?? []);
  return [...new Map(entries.map((entry) => [refKey(entry.ref), entry] as const)).values()];
}

// Not resolved yet, or resolved to an epic that has not been fetched yet.
function isPending(ref: IssueRef, snapshot: Snapshot | undefined): boolean {
  const resolution = snapshot?.issues[refKey(ref)];
  if (!resolution) return true;
  return resolution.epic !== null && snapshot?.epics[refKey(resolution.epic)] === undefined;
}

// The code of a resolution GitHub refused for good. It is cached for 30
// minutes, so the refresh that recorded it, and its error, may be long past.
function refusal(refs: readonly IssueRef[], snapshot: Snapshot | undefined): ErrorCode | undefined {
  return refs.map((ref) => snapshot?.issues[refKey(ref)]?.error).find((code) => code !== undefined);
}

// Bindings the status line says are still loading. Once the last refresh has
// failed they are not: that has its error to say, as in stateOf.
function pendingCount({ refs, snapshot }: Scoped): number {
  return snapshot?.error ? 0 : refs.filter((ref) => isPending(ref, snapshot)).length;
}

// The code behind the state: the last refresh's, or with nothing to show, a
// refused resolution's.
function errorOf({ refs, entries, snapshot }: Scoped): ErrorCode | null {
  return snapshot?.error ?? (entries.length === 0 ? refusal(refs, snapshot) : undefined) ?? null;
}

// Data wins over errors: anything already fetched is shown (stale if old or
// failed). Without data, a pending ref is loading unless the last refresh
// failed, and a refused one shows its code; otherwise the refs simply have
// no epic.
function stateOf(scoped: Scoped): StateKind {
  const { input, refs, entries, snapshot } = scoped;
  if (input.scope && isHookInactive(input.scope.session)) return 'hook-inactive';
  if (refs.length === 0) return 'none';
  if (entries.length > 0) return entries.some((entry) => isStale(entry, input.now)) ? 'stale' : 'ok';
  if (!refs.some((ref) => isPending(ref, snapshot)) && refusal(refs, snapshot) === undefined) return 'none';
  const error = errorOf(scoped);
  if (error === 'unsupported') return 'unsupported';
  return error ? 'error' : 'loading';
}

// A child's own URL names its repository (sub-issues may live elsewhere); a
// checklist item without one can only mean an issue of the epic's repository.
function childKey(child: Child, epic: IssueRef): string | undefined {
  const target = child.url === null ? undefined : parseIssueTarget(child.url);
  const own = target?.repo;
  const ref = target && own ? makeRef({ host: own.host ?? epic.host, owner: own.owner, repo: own.repo, number: target.number })
    : child.number === null ? undefined : makeRef({ ...epic, number: child.number });
  return ref ? refKey(ref) : undefined;
}

interface BoundSession {
  readonly sessionId: string;
  readonly keys: ReadonlySet<string>;
}

// The live sessions bound to one child, most recently live session first.
function childSessionIds(key: string | undefined, bound: readonly BoundSession[]): readonly string[] {
  return key === undefined ? [] : bound.filter((session) => session.keys.has(key)).map((session) => session.sessionId);
}

interface Activity {
  readonly activeSeconds: number;
  readonly lastActivityAt: string | null;
  readonly lastSessionId: string | null;
}

// Several issues' time as one: the sum, and the most recent of them.
function activityOf(entries: readonly (TimeRef | undefined)[]): Activity {
  const present = entries.filter((entry): entry is TimeRef => entry !== undefined);
  const latest = present.reduce<TimeRef | undefined>((best, entry) => (best === undefined || entry.lastTs > best.lastTs ? entry : best), undefined);
  return {
    activeSeconds: Math.floor(present.reduce((sum, entry) => sum + entry.ms, 0) / 1000),
    lastActivityAt: latest ? iso(latest.lastTs) : null,
    lastSessionId: latest?.lastSession ?? null,
  };
}

// An epic's own time plus every distinct issue's (a checklist may list one
// issue twice). A session is credited to one issue at a time, so the sum
// never counts the same minute twice.
function epicActivity(entry: EpicEntry, time: TimeFile | undefined): Activity {
  const keys = new Set(entry.children.flatMap((child) => childKey(child, entry.ref) ?? []));
  return activityOf([time?.refs[refKey(entry.ref)], ...[...keys].map((key) => time?.refs[key])]);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// What the hover says besides progress: the description's opening lines, how
// old the epic is, how many of its issues were finished this week, and who and
// what is in flight. All of it was stored by the refresh; only the week is
// worked out here, against the clock the view was built with.
function epicDetails(entry: EpicEntry, now: number): Pick<JsonEpic, 'summary' | 'createdAt' | 'doneLast7Days' | 'openPullRequests' | 'assignees'> {
  const assignees = [...new Set(entry.children.flatMap((child) => child.assignees ?? []))].slice(0, 5);
  return {
    summary: entry.summary ?? null,
    createdAt: entry.createdAt === undefined ? null : iso(entry.createdAt),
    doneLast7Days: entry.children.filter((child) => child.status === 'done' && child.closedAt !== undefined && now - child.closedAt >= 0 && now - child.closedAt <= WEEK_MS).length,
    openPullRequests: entry.children.reduce((sum, child) => sum + (child.openPrs ?? 0), 0),
    assignees,
  };
}

function jsonEpic(entry: EpicEntry, bound: readonly BoundSession[], input: { readonly now: number; readonly progress: ProgressConfig; readonly time: TimeFile | undefined }): JsonEpic {
  const counts = countStatuses(entry.children);
  const points = pointsByStatus(entry.children, input.progress);
  const children = entry.children.map((child) => {
    const sessionIds = childSessionIds(childKey(child, entry.ref), bound);
    const key = childKey(child, entry.ref);
    const time = key === undefined ? undefined : input.time?.refs[key];
    return { number: child.number, title: child.title, url: child.url, status: child.status, sessionCount: sessionIds.length, sessionIds, assignees: [...(child.assignees ?? [])], openPullRequests: child.openPrs ?? 0, ...activityOf([time]) };
  });
  const epicSessionIds = [...new Set(children.flatMap((child) => child.sessionIds))];
  return {
    number: entry.ref.number, title: entry.title, url: entry.url, kind: entry.kind, counts, percent: percentDone(points),
    weightedPercent: weightedPercentDone(points, input.progress), sessionIds: epicSessionIds, ...epicActivity(entry, input.time), ...epicDetails(entry, input.now),
    children, fetchedAt: iso(entry.fetchedAt), stale: isStale(entry, input.now), error: entry.error, truncated: entry.truncated,
  };
}

export function buildView(input: ViewInput): JsonV1 {
  const snapshot = input.snapshot.status === 'ok' ? input.snapshot.snapshot : undefined;
  const live = input.sessions.filter((session) => isLive(session, input.now));
  const refs = scopeRefs(input, live);
  const entries = epicEntries(refs, snapshot, pinnedKeys(input, live));
  const bound = live.map((session) => ({ sessionId: session.id, keys: new Set(activeBindings(session, input.now).map((binding) => refKey(binding.ref))) }));
  const scoped = { input, refs, entries, snapshot };
  return {
    version: 1,
    generatedAt: iso(input.now),
    liveSessions: live.length,
    pending: pendingCount(scoped),
    snapshot: { state: stateOf(scoped), fetchedAt: snapshot ? iso(snapshot.updatedAt) : null, error: errorOf(scoped) },
    epics: entries.map((entry) => jsonEpic(entry, bound, { now: input.now, progress: input.progress ?? DEFAULT_PROGRESS, time: input.time })),
  };
}
