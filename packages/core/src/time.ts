import { refKey } from './ref.js';
import type { RegistryLine } from './schemas/registry.js';
import type { TimeFile, TimeRef } from './schemas/time.js';

// Active session time. Between two consecutive hook calls of a session the
// elapsed time is credited to the issue(s) the session was last working on,
// unless the gap is longer than IDLE_CAP_MS: then nobody was driving it and
// nothing is counted. "Working on" is the issues of the latest call that
// bound any, for as long as that binding would live (six hours, or until
// unbound or the session ends; a pin does not lapse). One credit per
// interval, split evenly, so a session on two issues never counts twice and
// an epic's total is the plain sum of its issues'.

export const IDLE_CAP_MS = 10 * 60 * 1000;
const BINDING_TTL_MS = 6 * 60 * 60 * 1000;

export const EMPTY_TIME: TimeFile = { v: 1, sessions: {}, refs: {} };

interface Focus {
  readonly keys: readonly string[];
  readonly since: number;
  readonly pinned: boolean;
}

const NO_FOCUS: Focus = { keys: [], since: 0, pinned: false };

function nextFocus(focus: Focus, line: RegistryLine): Focus {
  if (line.ev === 'end') return NO_FOCUS;
  const unbound = new Set(line.unbinds.map(refKey));
  const kept = focus.keys.filter((key) => !unbound.has(key));
  const bound = line.binds.filter((bind) => !unbound.has(refKey(bind.ref)));
  if (bound.length > 0) return { keys: bound.map((bind) => refKey(bind.ref)), since: line.ts, pinned: bound.some((bind) => bind.via === 'pin') };
  const lapsed = !focus.pinned && line.ts - focus.since > BINDING_TTL_MS;
  return lapsed || kept.length === 0 ? NO_FOCUS : { ...focus, keys: kept };
}

export interface Credit {
  readonly ms: number;
  readonly lastTs: number;
}

// The credits for every interval that starts at or after `from`, by issue.
export function creditsFor(lines: readonly RegistryLine[], from: number): ReadonlyMap<string, Credit> {
  const ordered = [...lines].sort((a, b) => a.ts - b.ts);
  const credits = new Map<string, Credit>();
  const add = (key: string, ms: number, lastTs: number) => {
    const before = credits.get(key);
    credits.set(key, { ms: (before?.ms ?? 0) + ms, lastTs: Math.max(before?.lastTs ?? 0, lastTs) });
  };
  let focus = NO_FOCUS;
  ordered.forEach((line, index) => {
    focus = nextFocus(focus, line);
    for (const bind of line.binds) if (line.ts >= from) add(refKey(bind.ref), 0, line.ts);
    const next = ordered[index + 1];
    const gap = next ? next.ts - line.ts : 0;
    if (!next || line.ts < from || gap > IDLE_CAP_MS || focus.keys.length === 0) return;
    for (const key of focus.keys) add(key, Math.floor(gap / focus.keys.length), next.ts);
  });
  return credits;
}

function merged(before: TimeRef | undefined, credit: Credit, session: string): TimeRef {
  const newer = credit.lastTs >= (before?.lastTs ?? 0);
  return {
    ms: (before?.ms ?? 0) + credit.ms,
    lastTs: Math.max(before?.lastTs ?? 0, credit.lastTs),
    lastSession: newer ? session : (before?.lastSession ?? session),
  };
}

// The totals after counting everything the sessions have written since the
// last time. Pure: the refresher writes the result, readers only use it.
export function advanceTime(previous: TimeFile, sessions: ReadonlyMap<string, readonly RegistryLine[]>): TimeFile {
  const watermarks: Record<string, number> = {};
  const refs: Record<string, TimeRef> = { ...previous.refs };
  for (const [id, lines] of sessions) {
    const from = previous.sessions[id] ?? 0;
    for (const [key, credit] of creditsFor(lines, from)) refs[key] = merged(refs[key], credit, id);
    watermarks[id] = lines.reduce((latest, line) => Math.max(latest, line.ts), from);
  }
  return { v: 1, sessions: watermarks, refs };
}
