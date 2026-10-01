import { STATUSES, type JsonEpic, type Status } from '@epic-pulse/core';
import type { DisplayState } from './model.js';

// Every word the tree, the status bar and the details view use for a state or
// a status lives here, so the three can not drift apart. Icons are codicon ids.

export interface StateText {
  readonly label: string;
  readonly detail: string;
  readonly icon: string;
}

export const STATE_TEXT: Readonly<Record<Exclude<DisplayState, 'ok'>, StateText>> = {
  none: {
    label: 'No epic',
    detail: 'No live Claude Code session here is working on an issue that belongs to an epic, and nothing is pinned.',
    icon: 'pulse',
  },
  loading: { label: 'Loading…', detail: 'Waiting for the first refresh from GitHub.', icon: 'sync~spin' },
  stale: { label: 'Stale', detail: 'Showing data that is over ten minutes old, or from before a failed refresh.', icon: 'warning' },
  error: { label: 'Refresh failed', detail: 'GitHub could not be read.', icon: 'error' },
  'hook-inactive': {
    label: 'Hook inactive',
    detail: 'No Claude Code session has reported to this repository. Is the epic-pulse plugin enabled, and is Node on the PATH?',
    icon: 'debug-disconnect',
  },
  unsupported: { label: 'Unsupported host', detail: 'This GitHub host has no sub-issues, which epic-pulse needs.', icon: 'circle-slash' },
  'signed-out': {
    label: 'Sign in to GitHub',
    detail: 'No GitHub token that works was found. Sign in so Epic Pulse can read your epics.',
    icon: 'account',
  },
};

export const STATUS_TEXT: Readonly<Record<Status, { readonly label: string; readonly icon: string }>> = {
  todo: { label: 'Todo', icon: 'circle-large-outline' },
  in_progress: { label: 'In progress', icon: 'play-circle' },
  in_review: { label: 'In review', icon: 'git-pull-request' },
  done: { label: 'Done', icon: 'pass' },
  dropped: { label: 'Dropped', icon: 'circle-slash' },
};

// "20% · 1/5": done over countable, as in the status line, so dropped work
// leaves the denominator. A `+` marks an epic with more children than fit.
export function progressText(epic: JsonEpic): string {
  const total = STATUSES.reduce((sum, status) => sum + epic.counts[status], 0);
  return `${epic.percent}% · ${epic.counts.done}/${total - epic.counts.dropped}${epic.truncated ? '+' : ''}`;
}

export function countsText(epic: JsonEpic): string {
  return STATUSES.filter((status) => epic.counts[status] > 0)
    .map((status) => `${STATUS_TEXT[status].label} ${epic.counts[status]}`)
    .join(' · ');
}

export function sessionsText(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

export function ageText(fetchedAt: string | null, now: number): string {
  if (fetchedAt === null) return 'not refreshed yet';
  const seconds = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 1000));
  if (seconds < 60) return 'updated just now';
  return seconds < 3600 ? `updated ${Math.floor(seconds / 60)} min ago` : `updated ${Math.floor(seconds / 3600)} h ago`;
}
