import type { RepoRef, Status, StatusCounts } from './schemas/common.js';
import { STATUSES } from './schemas/common.js';
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

// Two routes to "a PR will close this issue":
//  1. closedByPullRequestsReferences, GitHub's own link;
//  2. an open same-repository PR that cross-references the issue and whose body
//     has a closing keyword for exactly this number. GitHub does not always
//     populate route 1 for a plain "Fixes #N" body, so route 2 is not optional.
// A merged or closed PR is not "in flight"; a merge closes the issue anyway.
export function linkedOpenPrs(node: SubIssueNode, repo: RepoRef): readonly PrNode[] {
  const linked = node.closedByPullRequestsReferences.nodes.filter((pr): pr is PrNode => pr !== null);
  const crossed = node.timelineItems.nodes.flatMap((item) => {
    const source = item?.source;
    return source && bodyClosesIssue(source.body ?? '', node.number, repo) ? [source] : [];
  });
  const byNumber = new Map([...linked, ...crossed].map((pr) => [pr.number, pr] as const));
  return [...byNumber.values()].filter((pr) => isOpenSameRepo(pr, repo));
}

// Precedence for an open issue: a ready PR (in review) beats a draft PR or an
// assignee (in progress), which beats nothing (todo).
export function deriveStatus(node: SubIssueNode, repo: RepoRef): Status {
  if (node.state === 'CLOSED') return DROPPED_REASONS.has(node.stateReason ?? '') ? 'dropped' : 'done';
  const prs = linkedOpenPrs(node, repo);
  if (prs.some((pr) => !pr.isDraft)) return 'in_review';
  return prs.length > 0 || node.assignees.totalCount > 0 ? 'in_progress' : 'todo';
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

export function isStale(entry: Pick<EpicEntry, 'fetchedAt' | 'error'>, now: number): boolean {
  return entry.error !== null || now - entry.fetchedAt > STALE_AFTER_MS;
}
