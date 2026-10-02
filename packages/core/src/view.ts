import { makeRef, parseIssueTarget, refKey } from './ref.js';
import { activeBindings, isHookInactive, isLive, type Binding, type SessionState } from './registry.js';
import type { ErrorCode, IssueRef, StateKind } from './schemas/common.js';
import type { JsonEpic, JsonV1 } from './schemas/json-v1.js';
import type { Pin } from './schemas/registry.js';
import type { Child, EpicEntry, Snapshot } from './schemas/snapshot.js';
import type { SnapshotRead } from './snapshot.js';
import { countStatuses, isStale, percentDone } from './status.js';

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

function epicEntries(refs: readonly IssueRef[], snapshot: Snapshot | undefined): readonly EpicEntry[] {
  const entries = refs.flatMap((ref) => {
    const epic = snapshot?.issues[refKey(ref)]?.epic;
    const entry = epic ? snapshot?.epics[refKey(epic)] : undefined;
    return entry ? [entry] : [];
  });
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

function jsonEpic(entry: EpicEntry, bound: readonly ReadonlySet<string>[], now: number): JsonEpic {
  const counts = countStatuses(entry.children);
  const children = entry.children.map((child) => {
    const key = childKey(child, entry.ref);
    return { ...child, sessionCount: key === undefined ? 0 : bound.filter((keys) => keys.has(key)).length };
  });
  return {
    number: entry.ref.number, title: entry.title, url: entry.url, kind: entry.kind, counts, percent: percentDone(counts),
    children, fetchedAt: iso(entry.fetchedAt), stale: isStale(entry, now), error: entry.error, truncated: entry.truncated,
  };
}

export function buildView(input: ViewInput): JsonV1 {
  const snapshot = input.snapshot.status === 'ok' ? input.snapshot.snapshot : undefined;
  const live = input.sessions.filter((session) => isLive(session, input.now));
  const refs = scopeRefs(input, live);
  const entries = epicEntries(refs, snapshot);
  const bound = live.map((session) => new Set(activeBindings(session, input.now).map((binding) => refKey(binding.ref))));
  const scoped = { input, refs, entries, snapshot };
  return {
    version: 1,
    generatedAt: iso(input.now),
    liveSessions: live.length,
    snapshot: { state: stateOf(scoped), fetchedAt: snapshot ? iso(snapshot.updatedAt) : null, error: errorOf(scoped) },
    epics: entries.map((entry) => jsonEpic(entry, bound, input.now)),
  };
}
