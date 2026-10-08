import { z } from 'zod';
import { ErrorCodeSchema, IssueNumberSchema, StateKindSchema, StatusCountsSchema, StatusSchema } from './common.js';
import { EpicKindSchema } from './snapshot.js';

// The public, versioned contract behind `epic-pulse json`, read by the VS Code
// extension and by anyone scripting against the CLI. Additive changes keep
// `version: 1`; renames or removals require `version: 2`.
export const JsonChildSchema = z
  .object({
    number: IssueNumberSchema.nullable(),
    title: z.string(),
    url: z.string().nullable(),
    status: StatusSchema,
    sessionCount: z.number().int().nonnegative(),
    // The live sessions bound to this child, most recent binding first.
    // sessionCount is their length, kept so a reader of only the count need
    // not change.
    sessionIds: z.array(z.string()).readonly(),
    // Active session time on this item, in seconds, with when and in which
    // session it was last worked on (null: never).
    activeSeconds: z.number().int().nonnegative(),
    lastActivityAt: z.iso.datetime().nullable(),
    lastSessionId: z.string().nullable(),
  })
  .readonly();

export const JsonEpicSchema = z
  .object({
    number: IssueNumberSchema,
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

export type JsonChild = z.infer<typeof JsonChildSchema>;
export type JsonEpic = z.infer<typeof JsonEpicSchema>;
export type JsonV1 = z.infer<typeof JsonV1Schema>;
