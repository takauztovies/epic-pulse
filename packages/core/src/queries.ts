import { classifyGraphqlErrors, classifyHttp } from './gql-errors.js';
import type { RawResponse } from './github.js';
import { fail, ok, type Result } from './result.js';
import type { ErrorCode } from './schemas/common.js';
import { IssueNumberSchema } from './schemas/common.js';
import {
  GqlEnvelopeSchema,
  PhaseADataSchema,
  PhaseBDataSchema,
  type EpicNode,
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
// always populate it for a "Fixes #N" body (the demo repo is such a case), so
// the same query also reads cross-reference events, whose PR body is checked for
// a closing keyword in status.ts. The nested connections multiply the rate-limit
// cost: 1 + 100 x 3 = 301 requests, which GitHub bills as 3 points per epic.
const EPIC_FRAGMENT = `fragment EpicFields on Issue {
  number title url body
  subIssues(first: 100) {
    totalCount
    nodes {
      number title url state stateReason
      assignees(first: 1) { totalCount }
      closedByPullRequestsReferences(first: 5) {
        nodes { number state isDraft url repository { nameWithOwner } }
      }
      timelineItems(last: 10, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest { number state isDraft url body repository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
}`;

export function phaseBDocument(numbers: readonly number[]): string {
  return `query PhaseB($owner: String!, $name: String!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    ${aliased('e', numbers, '{ ...EpicFields }')}
  }
}
${EPIC_FRAGMENT}`;
}

function toRate(node: RateLimitNode): RateInfo {
  return { cost: node.cost, remaining: node.remaining, resetAt: Date.parse(node.resetAt) || 0 };
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
  readonly rate: RateInfo;
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
  readonly rate: RateInfo;
  readonly epics: ReadonlyMap<number, EpicNode | null>;
}

export function parsePhaseB(res: RawResponse): Result<PhaseBParsed, Failure> {
  const opened = openEnvelope(res);
  if (!opened.ok) return opened;
  const data = PhaseBDataSchema.safeParse(opened.value.data);
  if (!data.success || !data.data.repository) return fail({ code: 'invalid_response', detail: 'phase_b_shape' });
  return ok({ rate: toRate(data.data.rateLimit), epics: keyed('e', data.data.repository) });
}
