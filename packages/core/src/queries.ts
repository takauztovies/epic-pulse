import { branchIssueNumber, DEFAULT_BRANCH_PATTERN } from './branch-pattern.js';
import { classifyGraphqlErrors, classifyHttp } from './gql-errors.js';
import type { RawResponse } from './github.js';
import { fail, ok, type Result } from './result.js';
import type { ErrorCode } from './schemas/common.js';
import { IssueNumberSchema } from './schemas/common.js';
import {
  EpicNodeSchema,
  GqlEnvelopeSchema,
  OpenPrsSchema,
  PhaseADataSchema,
  PhaseBDataSchema,
  type EpicNode,
  type PrNode,
  type PhaseAIssue,
  type RateLimitNode,
} from './schemas/graphql.js';

export interface Failure {
  readonly code: ErrorCode;
  readonly detail: string | null;
}

export interface RateInfo {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: number;
}

// Documents are read-only by construction: they start with `query` and no
// document here contains `mutation` or `subscription`. Issue numbers are the
// only interpolated values, and each goes through IssueNumberSchema first;
// owner and repo travel as GraphQL variables.
const RATE = 'rateLimit { cost remaining resetAt }';

function aliased(prefix: 'i' | 'e', numbers: readonly number[], selection: string): string {
  return numbers
    .map((n) => `${prefix}${IssueNumberSchema.parse(n)}: issue(number: ${n}) ${selection}`)
    .join('\n    ');
}

export function phaseADocument(numbers: readonly number[]): string {
  const selection = '{ number url parent { number url repository { nameWithOwner } } }';
  return `query PhaseA($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    ${aliased('i', numbers, selection)}
  }
}`;
}

// closedByPullRequestsReferences is the documented link, but GitHub does not
// always populate it for a "Fixes #N" body (the demo repo was such a case when
// its fixtures were first recorded), so the same query also reads
// cross-reference events, whose PR body is checked for a closing keyword in
// status.ts. Each sub-issue's own repository is read too: it may not be the
// epic's, and its pull requests are judged against it. The nested connections
// multiply the rate-limit cost: 1 + 100 x 4 = 401 requests, which GitHub bills
// as 4 points per epic; the repository is a plain field and costs nothing.
const EPIC_FRAGMENT = `fragment EpicFields on Issue {
  number title url body createdAt
  subIssues(first: 100) {
    totalCount
    nodes {
      number title url state stateReason closedAt repository { nameWithOwner }
      assignees(first: 3) { totalCount nodes { login } }
      subIssues(first: 1) { totalCount }
      labels(first: 20) { nodes { name } }
      closedByPullRequestsReferences(first: 5) {
        nodes { number state isDraft url repository { nameWithOwner } }
      }
      timelineItems(last: 10, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest { number state isDraft url body isCrossRepository repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}`;

// The repository's open pull requests, newest first, for the ones whose branch is
// named for an issue: such a pull request leaves no trace on the issue unless it
// also mentions it. A connection with nothing nested costs GitHub one request,
// not 100, so it adds no points (refresh-plan.ts).
const OPEN_PRS = 'openPrs: pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number state isDraft url headRefName isCrossRepository repository { nameWithOwner } } }';

export function phaseBDocument(numbers: readonly number[]): string {
  return `query PhaseB($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    ${aliased('e', numbers, '{ ...EpicFields }')}
    ${OPEN_PRS}
  }
}
${EPIC_FRAGMENT}`;
}

// Null when the server reports no rate limit; the refresher then charges its
// own estimate (refresh-batch.ts).
function toRate(node: RateLimitNode | null): RateInfo | null {
  return node === null ? null : { cost: node.cost, remaining: node.remaining, resetAt: Date.parse(node.resetAt) || 0 };
}

// HTTP status, then the GraphQL envelope, then fatal GraphQL errors. Returns the
// still-unparsed `data` plus the aliases GitHub reported as NOT_FOUND.
function openEnvelope(res: RawResponse): Result<{ data: unknown; missing: ReadonlySet<string> }, Failure> {
  const http = classifyHttp(res);
  if (http) return fail({ code: http, detail: `HTTP ${res.status}` });
  const envelope = GqlEnvelopeSchema.safeParse(res.body);
  if (!envelope.success) return fail({ code: 'invalid_response', detail: 'not_graphql_envelope' });
  const outcome = classifyGraphqlErrors(envelope.data.errors);
  if (outcome.fatal) return fail({ code: outcome.fatal, detail: null });
  return ok({ data: envelope.data.data, missing: outcome.missing });
}

function keyed<T>(prefix: string, record: Readonly<Record<string, T | null>>): ReadonlyMap<number, T | null> {
  const entries = Object.entries(record)
    .filter(([alias]) => alias.startsWith(prefix))
    .map(([alias, node]) => [Number(alias.slice(prefix.length)), node] as const);
  return new Map(entries);
}

export interface PhaseAParsed {
  readonly rate: RateInfo | null;
  readonly issues: ReadonlyMap<number, PhaseAIssue | null>;
}

export function parsePhaseA(res: RawResponse): Result<PhaseAParsed, Failure> {
  const opened = openEnvelope(res);
  if (!opened.ok) return opened;
  const data = PhaseADataSchema.safeParse(opened.value.data);
  if (!data.success || !data.data.repository) return fail({ code: 'invalid_response', detail: 'phase_a_shape' });
  return ok({ rate: toRate(data.data.rateLimit), issues: keyed('i', data.data.repository) });
}

export interface PhaseBParsed {
  readonly rate: RateInfo | null;
  readonly epics: ReadonlyMap<number, EpicNode | null>;
}

// Each sub-issue gets the open pull requests whose branch is named for it. A
// recording made before the list was asked for has none, and that is not an error.
function withBranchPrs(epics: ReadonlyMap<number, EpicNode | null>, prs: readonly (PrNode | null)[]): ReadonlyMap<number, EpicNode | null> {
  const byIssue = new Map<number, PrNode[]>();
  for (const pr of prs) {
    const number = pr?.headRefName === undefined ? undefined : branchIssueNumber(pr.headRefName, DEFAULT_BRANCH_PATTERN);
    // Anyone can open a PR from a fork, with any branch name: only a branch pushed to
    // this repository, by someone who can push here, speaks for an issue.
    if (pr && pr.isCrossRepository === false && number !== undefined) byIssue.set(number, [...(byIssue.get(number) ?? []), pr]);
  }
  return new Map([...epics].map(([number, epic]) => [number, epic && {
    ...epic,
    subIssues: { ...epic.subIssues, nodes: epic.subIssues.nodes.map((node) => node && { ...node, branchPullRequests: byIssue.get(node.number) ?? [] }) },
  }] as const));
}

export function parsePhaseB(res: RawResponse): Result<PhaseBParsed, Failure> {
  const opened = openEnvelope(res);
  if (!opened.ok) return opened;
  const data = PhaseBDataSchema.safeParse(opened.value.data);
  if (!data.success || !data.data.repository) return fail({ code: 'invalid_response', detail: 'phase_b_shape' });
  const epics = new Map<number, EpicNode | null>();
  for (const [number, raw] of keyed('e', data.data.repository)) {
    const epic = EpicNodeSchema.nullable().safeParse(raw ?? null);
    if (!epic.success) return fail({ code: 'invalid_response', detail: 'phase_b_shape' });
    epics.set(number, epic.data);
  }
  const prs = OpenPrsSchema.safeParse(data.data.repository['openPrs']);
  return ok({ rate: toRate(data.data.rateLimit), epics: withBranchPrs(epics, prs.success ? prs.data.nodes : []) });
}
