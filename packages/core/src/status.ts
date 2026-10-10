import type { RepoRef, Status, StatusCounts } from './schemas/common.js';
import { STATUSES } from './schemas/common.js';
import { DEFAULT_PROGRESS, type ProgressConfig } from './progress-config.js';
import type { PrNode, SubIssueNode } from './schemas/graphql.js';
import type { EpicEntry } from './schemas/snapshot.js';

// Data older than this is shown as stale. The Phase B cache is 2 minutes, so a
// live refresher keeps everything far inside the window; crossing it means
// nothing has refreshed for five cache lifetimes.
export const STALE_AFTER_MS = 10 * 60 * 1000;

// "Not planned" and "duplicate" are decisions not to do the work, so they leave
// the denominator. Any other close, including a legacy close with no reason, is
// finished work.
const DROPPED_REASONS: ReadonlySet<string> = new Set(['NOT_PLANNED', 'DUPLICATE']);

// GitHub's closing keywords, with the optional colon it accepts ("Fixes: #4").
// Three reference forms: `#4`, `owner/repo#4` and a full issue URL.
export const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[ \t]*:?[ \t]+(?:([\w.-]+\/[\w.-]+)#|#|https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/issues\/)(\d+)(?!\d)/gi;

function slugOf(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function bodyClosesIssue(body: string, issueNumber: number, repo: RepoRef): boolean {
  for (const match of body.matchAll(CLOSING)) {
    const target = (match[1] ?? match[2])?.toLowerCase();
    if (Number(match[3]) === issueNumber && (target === undefined || target === slugOf(repo))) return true;
  }
  return false;
}

function isOpenSameRepo(pr: PrNode, repo: RepoRef): boolean {
  return pr.state === 'OPEN' && pr.repository.nameWithOwner.toLowerCase() === slugOf(repo);
}

// Three routes to "a PR is this issue's work":
//  1. closedByPullRequestsReferences, GitHub's own link;
//  2. an open same-repository PR that cross-references the issue and whose body
//     has a closing keyword for exactly this number. GitHub does not always
//     populate route 1 for a plain "Fixes #N" body, so route 2 is not optional;
//  3. an open same-repository PR whose branch is named for the issue
//     (`123-login`), which leaves no trace on the issue at all unless it also
//     mentions it (parsePhaseB attaches these).
// A merged or closed PR is not "in flight"; a merge closes the issue anyway.
export function linkedOpenPrs(node: SubIssueNode, repo: RepoRef): readonly PrNode[] {
  const linked = [...node.closedByPullRequestsReferences.nodes.filter((pr): pr is PrNode => pr !== null), ...(node.branchPullRequests ?? [])];
  const crossed = node.timelineItems.nodes.flatMap((item) => {
    const source = item?.source;
    return source && bodyClosesIssue(source.body ?? '', node.number, repo) ? [source] : [];
  });
  const byNumber = new Map([...linked, ...crossed].map((pr) => [pr.number, pr] as const));
  return [...byNumber.values()].filter((pr) => isOpenSameRepo(pr, repo));
}

// A PR that names more issues than this is a release note or a sweep, not work
// on any one of them (the hook draws the same line for a single tool call).
export const MAX_MENTIONS = 3;
const MENTION = /(?:^|[^\w/#])#(\d+)(?!\d)|\/issues\/(\d+)(?!\d)/g;

function issuesNamedIn(body: string): number {
  return new Set([...body.slice(0, 20_000).matchAll(MENTION)].map((match) => match[1] ?? match[2])).size;
}

// An open same-repository PR that mentions the issue without closing it: work
// under way, but not proof it will close it, so it counts as in progress only.
export function mentioningOpenPrs(node: SubIssueNode, repo: RepoRef): readonly PrNode[] {
  return node.timelineItems.nodes.flatMap((item) => {
    const source = item?.source;
    // From a branch in this repository only: anyone can open a PR from a fork that mentions any issue.
    const own = source?.isCrossRepository === false;
    return source && own && isOpenSameRepo(source, repo) && issuesNamedIn(source.body ?? '') <= MAX_MENTIONS ? [source] : [];
  });
}

// Precedence for an open issue: a ready PR that is its work (in review) beats a
// draft one, a PR that only mentions it, or an assignee (in progress), which
// beat nothing (todo).
export function deriveStatus(node: SubIssueNode, repo: RepoRef): Status {
  if (node.state === 'CLOSED') return DROPPED_REASONS.has(node.stateReason ?? '') ? 'dropped' : 'done';
  const prs = linkedOpenPrs(node, repo);
  if (prs.some((pr) => !pr.isDraft)) return 'in_review';
  const moving = prs.length > 0 || mentioningOpenPrs(node, repo).length > 0 || node.assignees.totalCount > 0;
  return moving ? 'in_progress' : 'todo';
}

// The status counts again, but summed in points instead of items: an item is
// worth the size its labels name, and the larger when they name two. An item
// that names none is worth `unsized`. With no size labels anywhere every item
// is worth the same, so the percentages are the plain item ratios.
export function pointsByStatus(
  children: readonly { readonly status: Status; readonly labels?: readonly string[] | undefined }[],
  progress: ProgressConfig = DEFAULT_PROGRESS,
): StatusCounts {
  const zero: StatusCounts = { todo: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };
  const worth = (labels: readonly string[] | undefined) =>
    Math.max(0, ...(labels ?? []).map((label) => progress.sizes[label] ?? 0)) || progress.unsized;
  return children.reduce((points, child) => ({ ...points, [child.status]: points[child.status] + worth(child.labels) }), zero);
}

export function countStatuses(children: readonly { readonly status: Status }[]): StatusCounts {
  const zero: StatusCounts = { todo: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };
  return children.reduce((counts, child) => ({ ...counts, [child.status]: counts[child.status] + 1 }), zero);
}

// done / (total - dropped). Floored, so 100 means complete: 199 of 200 must not
// round up to a finished epic. With nothing countable the answer is 0.
export function percentDone(counts: StatusCounts): number {
  const total = STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const denominator = total - counts.dropped;
  return denominator <= 0 ? 0 : Math.floor((counts.done * 100) / denominator);
}

// Weighted counterpart of percentDone, floored and over the same denominator.
// Work in flight counts for the configured share of an item, never all of it,
// so the result is 100 only when every counted item is done. Whole numbers
// throughout: the weights are percentages, so nothing rounds before the floor.
export function weightedPercentDone(points: StatusCounts, progress: ProgressConfig = DEFAULT_PROGRESS): number {
  const total = STATUSES.reduce((sum, status) => sum + points[status], 0);
  const denominator = total - points.dropped;
  if (denominator <= 0) return 0;
  const credited = points.done * 100 + points.in_review * progress.inReview + points.in_progress * progress.inProgress;
  return Math.floor(credited / denominator);
}

export function isStale(entry: Pick<EpicEntry, 'fetchedAt' | 'error'>, now: number): boolean {
  return entry.error !== null || now - entry.fetchedAt > STALE_AFTER_MS;
}
