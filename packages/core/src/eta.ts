import type { Child } from './schemas/snapshot.js';
import { countStatuses } from './status.js';

// An epic's pace is what it finished in the last PACE_DAYS days. One close is an
// accident and not a pace, so an estimate needs at least MIN_DONE of them.
export const PACE_DAYS = 14;
const MIN_DONE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// Closed as done inside the window, as far as the close has a date: a done item
// with none (a checklist's, or one recorded before the snapshot kept them) is not
// counted, and one dated after `now` is not either.
function doneInWindow(leaves: readonly Child[], now: number): number {
  return leaves.filter((leaf) => leaf.status === 'done' && leaf.closedAt !== undefined && now - leaf.closedAt >= 0 && now - leaf.closedAt <= PACE_DAYS * DAY_MS).length;
}

// When the epic is on course to finish, as a calendar day (UTC, YYYY-MM-DD): the
// items still open at the pace of the window, rounded up to whole days so it is
// never a day sooner than the pace allows. Dropped work is not left to do, as in
// percentDone. null when there is no pace to project, or nothing is left.
export function etaOf(leaves: readonly Child[], now: number): string | null {
  const { todo, in_progress: progress, in_review: review } = countStatuses(leaves);
  const open = todo + progress + review;
  const done = doneInWindow(leaves, now);
  if (done < MIN_DONE || open === 0) return null;
  return new Date(now + Math.ceil((open * PACE_DAYS) / done) * DAY_MS).toISOString().slice(0, 10);
}

// "05.11.": the day and month of an ETA, as the status line and the hover show it.
export function etaLabel(eta: string): string {
  return `${eta.slice(8, 10)}.${eta.slice(5, 7)}.`;
}
