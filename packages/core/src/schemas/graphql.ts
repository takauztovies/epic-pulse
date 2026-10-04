import { z } from 'zod';
import { IssueNumberSchema } from './common.js';

export const GqlErrorSchema = z.looseObject({
  message: z.string().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
  path: z.array(z.union([z.string(), z.number()])).optional().catch(undefined),
  extensions: z
    .looseObject({ code: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

// Parsed first, on its own: `data` may be partial next to `errors` (one alias
// not found, the rest fine), so the envelope is checked before the payload.
export const GqlEnvelopeSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(GqlErrorSchema).optional().catch(undefined),
});

// Taken as nullable below: a GitHub Enterprise Server with rate limiting
// turned off answers `rateLimit: null`.
export const RateLimitNodeSchema = z.object({
  cost: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});

const RepoNameSchema = z.object({ nameWithOwner: z.string() });

export const PhaseAIssueSchema = z.object({
  number: IssueNumberSchema,
  url: z.string(),
  parent: z.object({ number: IssueNumberSchema, url: z.string(), repository: RepoNameSchema }).nullable(),
});

// Repository fields are aliases chosen at query time (`i5`, `e1`), so the
// repository object is a record rather than a fixed shape.
export const PhaseADataSchema = z.object({
  rateLimit: RateLimitNodeSchema.nullable(),
  repository: z.record(z.string(), PhaseAIssueSchema.nullable()).nullable(),
});

export const PrNodeSchema = z.object({
  number: IssueNumberSchema,
  state: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
  body: z.string().optional(),
  repository: RepoNameSchema,
});

export const PrSourceSchema = PrNodeSchema.extend({ __typename: z.literal('PullRequest') });
// Only pull requests matter to status derivation. A cross-reference from a plain
// issue (or anything else) becomes `undefined` here instead of a union member
// the type system can not tell apart from a pull request.
const TimelineNodeSchema = z.looseObject({ source: PrSourceSchema.optional().catch(undefined) });

// State and reason stay plain strings: GitHub adds enum values over time and a
// new one must degrade to "open" or "done", not fail the whole epic. The
// repository is the sub-issue's own, which may not be the epic's.
export const SubIssueNodeSchema = z.object({
  number: IssueNumberSchema,
  title: z.string(),
  url: z.string(),
  state: z.string(),
  stateReason: z.string().nullable(),
  repository: RepoNameSchema,
  assignees: z.object({ totalCount: z.number().int().nonnegative() }),
  closedByPullRequestsReferences: z.object({ nodes: z.array(PrNodeSchema.nullable()) }),
  timelineItems: z.object({ nodes: z.array(TimelineNodeSchema.nullable()) }),
});

export const EpicNodeSchema = z.object({
  number: IssueNumberSchema,
  title: z.string(),
  url: z.string(),
  body: z.string(),
  subIssues: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(SubIssueNodeSchema.nullable()),
  }),
});

export const PhaseBDataSchema = z.object({
  rateLimit: RateLimitNodeSchema.nullable(),
  repository: z.record(z.string(), EpicNodeSchema.nullable()).nullable(),
});

export type GqlError = z.infer<typeof GqlErrorSchema>;
export type PhaseAIssue = z.infer<typeof PhaseAIssueSchema>;
export type PhaseAData = z.infer<typeof PhaseADataSchema>;
export type PrNode = z.infer<typeof PrNodeSchema>;
export type SubIssueNode = z.infer<typeof SubIssueNodeSchema>;
export type EpicNode = z.infer<typeof EpicNodeSchema>;
export type PhaseBData = z.infer<typeof PhaseBDataSchema>;
export type PrSource = z.infer<typeof PrSourceSchema>;
export type TimelineNode = z.infer<typeof TimelineNodeSchema>;
export type RateLimitNode = z.infer<typeof RateLimitNodeSchema>;
