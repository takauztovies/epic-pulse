import { z } from 'zod';
import { ErrorCodeSchema, IssueNumberSchema, StateKindSchema, StatusCountsSchema, StatusSchema } from './common.js';
import { EpicKindSchema } from './snapshot.js';

// The public, versioned contract behind `epic-pulse json`, read by the VS Code
// extension and by anyone scripting against the CLI. Additive changes keep
// `version: 1`; renames or removals require `version: 2`.
export interface JsonChild {
  readonly number: number | null;
  // What to call it: `#12`, or `PROJ-12` on Jira; null for a plain checklist line.
  readonly key: string | null;
  readonly title: string;
  readonly url: string | null;
  readonly status: z.infer<typeof StatusSchema>;
  // How many sub-issues it has (0: a leaf). When they have been fetched they are `children`.
  readonly subCount: number;
  readonly sessionCount: number;
  // The live sessions bound to this item or anything below it, most recent binding first.
  // sessionCount is their length, kept so a reader of only the count need not change.
  readonly sessionIds: readonly string[];
  // Who it is assigned to (logins, up to five, below it too) and how many open pull requests
  // will close it or anything below it.
  readonly assignees: readonly string[];
  readonly openPullRequests: number;
  // Active session time on this item and everything below it, in seconds, with when and in
  // which session it was last worked on (null: never).
  readonly activeSeconds: number;
  readonly lastActivityAt: string | null;
  readonly lastSessionId: string | null;
  // For an item with items below it: the status counts of its leaves and the percent done.
  // null for a leaf.
  readonly counts: z.infer<typeof StatusCountsSchema> | null;
  readonly percent: number | null;
  // The items below it, however deep. Empty for a leaf, and until a sub-epic has been fetched.
  readonly children: readonly JsonChild[];
}

export const JsonChildSchema: z.ZodType<JsonChild> = z.lazy(() =>
  z
    .object({
      number: IssueNumberSchema.nullable(),
      key: z.string().nullable(),
      title: z.string(),
      url: z.string().nullable(),
      status: StatusSchema,
      subCount: z.number().int().nonnegative(),
      sessionCount: z.number().int().nonnegative(),
      sessionIds: z.array(z.string()).readonly(),
      assignees: z.array(z.string()).readonly(),
      openPullRequests: z.number().int().nonnegative(),
      activeSeconds: z.number().int().nonnegative(),
      lastActivityAt: z.iso.datetime().nullable(),
      lastSessionId: z.string().nullable(),
      counts: StatusCountsSchema.nullable(),
      percent: z.number().int().min(0).max(100).nullable(),
      children: z.array(JsonChildSchema).readonly(),
    })
    .readonly(),
);

export const JsonEpicSchema = z
  .object({
    number: IssueNumberSchema,
    // What to call it: `#1`, or `PROJ-1` on Jira.
    key: z.string(),
    title: z.string(),
    url: z.string(),
    kind: EpicKindSchema,
    counts: StatusCountsSchema,
    percent: z.number().int().min(0).max(100),
    weightedPercent: z.number().int().min(0).max(100),
    children: z.array(JsonChildSchema).readonly(),
    // Every live session bound to any child of this epic, deduplicated: the
    // epic-level answer to "which session is working on this".
    sessionIds: z.array(z.string()).readonly(),
    // Active session time on this epic: its own and all its issues', in seconds, with when and in which
    // session it was last worked on (null: never).
    activeSeconds: z.number().int().nonnegative(),
    lastActivityAt: z.iso.datetime().nullable(),
    lastSessionId: z.string().nullable(),
    // A few readable lines of its description, and when it was opened (null: not known).
    summary: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
    // Issues closed as done in the last seven days: is it moving?
    doneLast7Days: z.number().int().nonnegative(),
    // Open pull requests across its issues, and who its issues are assigned to (up to five logins).
    openPullRequests: z.number().int().nonnegative(),
    assignees: z.array(z.string()).readonly(),
    fetchedAt: z.iso.datetime(),
    stale: z.boolean(),
    error: ErrorCodeSchema.nullable(),
    truncated: z.boolean(),
  })
  .readonly();

export const JsonV1Schema = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    liveSessions: z.number().int().nonnegative(),
    // How many of the view's bindings are still waiting for an answer: never
    // resolved, or resolved to an epic not fetched yet. 0 once a refresh has
    // failed, which has its error to say instead. Added to version 1 later.
    pending: z.number().int().nonnegative(),
    snapshot: z
      .object({
        state: StateKindSchema,
        fetchedAt: z.iso.datetime().nullable(),
        error: ErrorCodeSchema.nullable(),
      })
      .readonly(),
    epics: z.array(JsonEpicSchema).readonly(),
  })
  .readonly();

export type JsonEpic = z.infer<typeof JsonEpicSchema>;
export type JsonV1 = z.infer<typeof JsonV1Schema>;
