import { checklistChildren } from './checklist.js';
import { makeRef, refKey } from './ref.js';
import type { IssueRef, RepoRef } from './schemas/common.js';
import type { EpicNode, PhaseAIssue, SubIssueNode } from './schemas/graphql.js';
import { MAX_CHILDREN, type Child, type EpicEntry, type Snapshot } from './schemas/snapshot.js';
import { PROGRESS_LIMITS } from './progress-config.js';
import { summaryOf } from './summary.js';
import { deriveStatus, linkedOpenPrs } from './status.js';

// An epic as fetched, before the refresher stamps it with fetchedAt and error.
export type EpicData = Omit<EpicEntry, 'fetchedAt' | 'error'>;

// Phase A. A sub-issue belongs to its parent's epic; an issue with no parent is
// itself the epic candidate (Phase B decides whether it really is one). The
// parent may live in another repository of the same host.
export function epicRefFor(ref: IssueRef, node: PhaseAIssue | null): IssueRef | null {
  if (node === null) return null;
  if (node.parent === null) return ref;
  const [owner, repo] = node.parent.repository.nameWithOwner.split('/');
  if (!owner || !repo) return null;
  return makeRef({ kind: ref.kind, host: ref.host, owner, repo, number: node.parent.number }) ?? null;
}

// A sub-issue may live in another repository of the epic's host. Its pull
// requests are judged against its own repository: a closing keyword without
// a repository names an issue there, and a pull request elsewhere is not its.
function ownRepo(node: SubIssueNode, epic: IssueRef): RepoRef {
  const [owner, repo] = node.repository.nameWithOwner.split('/');
  const own = owner && repo ? makeRef({ host: epic.host, owner, repo, number: node.number }) : undefined;
  return own ?? epic;
}

// Lowercased, since GitHub label names are case-insensitive: `Size/XL` and
// `size/xl` are one label. One too long to be a name is not kept.
function labelsOf(node: SubIssueNode): readonly string[] {
  const names = (node.labels?.nodes ?? []).flatMap((label) => (label ? [label.name.toLowerCase()] : []));
  return names.filter((name) => name.length <= PROGRESS_LIMITS.maxLabelLength);
}

function assigneesOf(node: SubIssueNode): readonly string[] {
  return (node.assignees.nodes ?? []).flatMap((user) => (user ? [user.login.slice(0, 40)] : [])).slice(0, 3);
}

function timeOf(text: string | null | undefined): number | undefined {
  const ms = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function subIssueChild(node: SubIssueNode, epic: IssueRef): Child {
  const labels = labelsOf(node);
  const assignees = assigneesOf(node);
  const status = deriveStatus(node, ownRepo(node, epic));
  const openPrs = status === 'done' || status === 'dropped' ? 0 : linkedOpenPrs(node, ownRepo(node, epic)).length;
  const closedAt = status === 'done' ? timeOf(node.closedAt) : undefined;
  const subCount = node.subIssues?.totalCount ?? 0;
  return {
    number: node.number,
    title: node.title.slice(0, 300),
    url: node.url.slice(0, 500),
    status,
    ...(labels.length === 0 ? {} : { labels }),
    ...(assignees.length === 0 ? {} : { assignees }),
    ...(openPrs === 0 ? {} : { openPrs }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(subCount === 0 ? {} : { subCount }),
  };
}

// Phase B. Sub-issues win over a checklist; a checklist is the fallback for
// epics that are only a list of boxes. Returns null when the issue is neither,
// i.e. it is not an epic at all. GitHub caps a page at 100 sub-issues and we do
// not paginate, and the snapshot keeps at most MAX_CHILDREN of a checklist's
// boxes, so a larger epic is flagged `truncated` instead of shown as if
// complete.
export function buildEpic(node: EpicNode, ref: IssueRef): EpicData | null {
  const subs = node.subIssues.nodes.filter((n): n is SubIssueNode => n !== null);
  const kind = node.subIssues.totalCount > 0 ? 'subissues' : 'checklist';
  const children = kind === 'subissues' ? subs.map((n) => subIssueChild(n, ref)) : checklistChildren(node.body, ref);
  if (children.length === 0) return null;
  const summary = summaryOf(node.body);
  return {
    ref,
    title: node.title.slice(0, 300),
    url: node.url.slice(0, 500),
    kind,
    children: children.slice(0, MAX_CHILDREN),
    truncated: node.subIssues.totalCount > subs.length || children.length > MAX_CHILDREN,
    ...(summary === undefined ? {} : { summary }),
    ...(timeOf(node.createdAt) === undefined ? {} : { createdAt: timeOf(node.createdAt) }),
  };
}

// The epic keys the bound refs resolve to, without duplicates and in order.
export function epicKeysFor(refs: readonly IssueRef[], snapshot: Snapshot): readonly string[] {
  const keys = refs.flatMap((ref) => {
    const epic = snapshot.issues[refKey(ref)]?.epic;
    return epic ? [refKey(epic)] : [];
  });
  return [...new Set(keys)];
}

// Refs the snapshot has never resolved. They show as "loading" until Phase A runs.
export function unresolvedRefs(refs: readonly IssueRef[], snapshot: Snapshot): readonly IssueRef[] {
  return refs.filter((ref) => snapshot.issues[refKey(ref)] === undefined);
}

// Epics the snapshot has never fetched. They show as "loading" until Phase B runs.
export function unfetchedEpics(epics: readonly IssueRef[], snapshot: Snapshot): readonly IssueRef[] {
  return epics.filter((epic) => snapshot.epics[refKey(epic)] === undefined);
}
