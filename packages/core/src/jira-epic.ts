import { adfText } from './jira-adf.js';
import type { JiraConfig } from './jira-config.js';
import { deriveJiraStatus } from './jira-status.js';
import { displayKey, issueUrl, JIRA_KEY, makeJiraRef } from './ref.js';
import type { EpicData } from './resolve.js';
import type { IssueRef } from './schemas/common.js';
import type { PhaseAIssue } from './schemas/graphql.js';
import type { JiraIssue, JiraPhaseB, JiraSearch } from './schemas/jira.js';
import { MAX_CHILDREN, type Child } from './schemas/snapshot.js';
import { summaryOf } from './summary.js';

// Turns what Jira answered into what the snapshot stores, through the same
// types the GitHub side fills (PhaseAIssue for "which epic is this in",
// EpicData for "what is in the epic"), so everything after the fetch is shared.

const same = (issue: JiraIssue, ref: IssueRef): boolean => issue.key.toUpperCase() === displayKey(ref);

function timeOf(text: string | undefined): number | undefined {
  const ms = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function parentOf(ref: IssueRef, issue: JiraIssue): IssueRef | undefined {
  const parts = JIRA_KEY.exec(issue.fields?.parent?.key ?? '');
  return parts ? makeJiraRef({ host: ref.host, project: parts[1] ?? '', number: Number(parts[2]) }) : undefined;
}

// Phase A. Jira has one parent per issue: that is its epic. An issue with none
// is the epic candidate itself, as on GitHub (Phase B decides if it has children).
export function resolutionAnswers(refs: readonly IssueRef[], search: JiraSearch): readonly (readonly [IssueRef, PhaseAIssue | null])[] {
  return refs.map((ref) => {
    const issue = search.issues.find((candidate) => same(candidate, ref));
    if (!issue) return [ref, null] as const;
    const parent = parentOf(ref, issue);
    const node: PhaseAIssue = {
      number: ref.number,
      url: issueUrl(ref),
      parent: parent ? { number: parent.number, url: issueUrl(parent), repository: { nameWithOwner: `${parent.owner}/${parent.repo}` } } : null,
    };
    return [ref, node] as const;
  });
}

function childOf(issue: JiraIssue, host: string, config: JiraConfig | undefined): Child | undefined {
  const parts = JIRA_KEY.exec(issue.key);
  const ref = parts ? makeJiraRef({ host, project: parts[1] ?? '', number: Number(parts[2]) }) : undefined;
  if (!ref) return undefined;
  const fields = issue.fields;
  const status = deriveJiraStatus({ statusName: fields?.status?.name, categoryKey: fields?.status?.statusCategory?.key, resolution: fields?.resolution?.name }, config);
  const labels = (fields?.labels ?? []).map((label) => label.toLowerCase()).filter((label) => label.length <= 60).slice(0, 20);
  const assignee = fields?.assignee?.displayName?.slice(0, 40);
  const closedAt = status === 'done' ? timeOf(fields?.resolutiondate) : undefined;
  return {
    number: ref.number,
    key: displayKey(ref),
    title: (fields?.summary ?? issue.key).slice(0, 300),
    url: issueUrl(ref).slice(0, 500),
    status,
    ...(labels.length === 0 ? {} : { labels }),
    ...(assignee ? { assignees: [assignee] } : {}),
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

interface Found {
  readonly epic: JiraIssue;
  readonly children: { readonly issues: readonly JiraIssue[]; readonly complete: boolean };
}

function epicOf(ref: IssueRef, found: Found, config: JiraConfig | undefined): EpicData | null {
  const { epic } = found;
  const children = found.children.issues.flatMap((issue) => childOf(issue, ref.host, config) ?? []);
  if (children.length === 0) return null;
  const summary = summaryOf(adfText(epic.fields?.description));
  const createdAt = timeOf(epic.fields?.created);
  return {
    ref,
    title: (epic.fields?.summary ?? epic.key).slice(0, 300),
    url: issueUrl(ref).slice(0, 500),
    kind: 'subissues',
    children: children.slice(0, MAX_CHILDREN),
    truncated: !found.children.complete || children.length > MAX_CHILDREN,
    ...(summary === undefined ? {} : { summary }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

// Phase B. An issue that is not found, or has no children, is not an epic.
export function epicAnswers(refs: readonly IssueRef[], data: JiraPhaseB, config: JiraConfig | undefined): readonly (readonly [IssueRef, EpicData | null])[] {
  return refs.map((ref) => {
    const epic = data.epics.issues.find((candidate) => same(candidate, ref));
    const children = data.children[displayKey(ref)];
    return [ref, epic && children ? epicOf(ref, { epic, children }, config) : null] as const;
  });
}
