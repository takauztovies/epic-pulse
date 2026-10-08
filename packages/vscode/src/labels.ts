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

const BAR_CELLS = 10;

// "██░░░░░░░░": percent in tenths, rounded down so a bar is never full before the epic is done.
export function barText(percent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.floor(percent / BAR_CELLS)));
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

export function countsText(epic: JsonEpic): string {
  return STATUSES.filter((status) => epic.counts[status] > 0)
    .map((status) => `${STATUS_TEXT[status].label} ${epic.counts[status]}`)
    .join(' · ');
}

export function sessionsText(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

// The first 8 characters of a session id: enough to tell sessions apart in a
// tooltip line, short enough that it reads as a label and not a UUID dump.
function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

// The epic-level answer to "which session is this": every live session bound
// to any of its children, so a multi-root window's merged view still says
// which one to go back to, not only how many there are.
export function epicSessionsText(epic: Pick<JsonEpic, 'sessionIds'>): string {
  if (epic.sessionIds.length === 0) return 'No live session';
  return `${epic.sessionIds.length === 1 ? 'Session' : 'Sessions'}: ${epic.sessionIds.map(shortSessionId).join(', ')}`;
}

export function ageText(fetchedAt: string | null, now: number): string {
  if (fetchedAt === null) return 'not refreshed yet';
  const seconds = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 1000));
  if (seconds < 60) return 'updated just now';
  return seconds < 3600 ? `updated ${Math.floor(seconds / 60)} min ago` : `updated ${Math.floor(seconds / 3600)} h ago`;
}

// "3 h 20 min": session time as people say it. Under a minute is "under 1 min"
// and nothing at all is "none yet", so a zero is never mistaken for a missing figure.
export function durationText(seconds: number): string {
  if (seconds <= 0) return 'none yet';
  if (seconds < 60) return 'under 1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function agoText(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  return seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
}

interface Activity {
  readonly activeSeconds: number;
  readonly lastActivityAt: string | null;
  readonly lastSessionId: string | null;
}

// The hover lines for time: what sessions spent on it, and the last time one
// was on it, in which session.
export function activityLines(item: Activity, now: number): readonly string[] {
  const time = `Session time: ${durationText(item.activeSeconds)}`;
  if (item.lastActivityAt === null) return [time];
  const session = item.lastSessionId === null ? '' : ` (session ${shortSessionId(item.lastSessionId)})`;
  return [time, `Last active ${agoText(item.lastActivityAt, now)}${session}`];
}

function ageOnlyText(iso: string, now: number): string {
  const days = Math.floor(Math.max(0, now - Date.parse(iso)) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? '1 day ago' : days < 60 ? `${days} days ago` : `${Math.floor(days / 30)} months ago`;
}

interface Details {
  readonly summary: string | null;
  readonly createdAt: string | null;
  readonly doneLast7Days: number;
  readonly openPullRequests: number;
  readonly assignees: readonly string[];
}

// The hover's extra lines for an epic: its description's opening lines, how
// many pull requests are open and who is assigned, and how old it is with
// how much of it was finished this week. A line with nothing to say is left out.
export function detailLines(epic: Details, now: number): readonly string[] {
  const people = epic.assignees.length === 0 ? [] : [`Assigned: ${epic.assignees.map((login) => `@${login}`).join(', ')}`];
  const flight = [`Open pull requests: ${epic.openPullRequests}`, ...people].join(' · ');
  const age = epic.createdAt === null ? [] : [`Opened ${ageOnlyText(epic.createdAt, now)}`];
  const moving = [...age, `${epic.doneLast7Days} done in the last 7 days`].join(' · ');
  return [...(epic.summary === null ? [] : [`Summary: ${epic.summary}`]), flight, moving];
}

// The same for an issue: who has it and what is in flight on it.
export function issueDetailLines(issue: Pick<Details, 'assignees' | 'openPullRequests'>): readonly string[] {
  const people = issue.assignees.length === 0 ? [] : [`Assigned: ${issue.assignees.map((login) => `@${login}`).join(', ')}`];
  const prs = issue.openPullRequests === 0 ? [] : [`Open pull requests: ${issue.openPullRequests}`];
  return [...people, ...prs];
}
