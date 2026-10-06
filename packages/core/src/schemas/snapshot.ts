import { z } from 'zod';
import { ErrorCodeSchema, IssueNumberSchema, IssueRefSchema, StatusSchema } from './common.js';

export const EpicKindSchema = z.enum(['subissues', 'checklist']);

// A checklist item that is plain text has no issue behind it, hence nullable
// number and url. Counts and percent are NOT stored: they are derived from the
// children on read so the two can never disagree.
export const ChildSchema = z
  .object({
    number: IssueNumberSchema.nullable(),
    title: z.string().max(300),
    url: z.string().max(500).nullable(),
    status: StatusSchema,
    // The size label this item carries, lowercased (`size/xl`); absent: unsized.
    size: z.string().max(60).optional(),
  })
  .readonly();

// The most children an epic keeps. resolve.ts cuts a longer epic here and
// flags it `truncated`, so a long checklist can not fail the snapshot.
export const MAX_CHILDREN = 500;

export const EpicEntrySchema = z
  .object({
    ref: IssueRefSchema,
    title: z.string().max(300),
    url: z.string().max(500),
    kind: EpicKindSchema,
    children: z.array(ChildSchema).max(MAX_CHILDREN).readonly(),
    truncated: z.boolean(),
    fetchedAt: z.number().int().nonnegative(),
    error: ErrorCodeSchema.nullable(),
  })
  .readonly();

// `error`: GitHub refused the lookup for good (refresh-batch.ts), so the
// issue resolves to no epic for as long as any resolution is cached.
// `isEpic`: an issue with a parent resolves to the parent, and a pin names the
// issue itself, so Phase B also asks whether a pinned issue is an epic. true:
// it is, and its own entry is in `epics`; false: it is not, and is not asked
// again until Phase A resolves it again, which drops the answer. Absent: not
// asked.
export const ResolutionSchema = z
  .object({ epic: IssueRefSchema.nullable(), resolvedAt: z.number().int().nonnegative(), error: ErrorCodeSchema.optional(), isEpic: z.boolean().optional() })
  .readonly();

export const UsageSchema = z
  .object({ windowStart: z.number().int().nonnegative(), points: z.number().nonnegative() })
  .readonly();
export const RateLimitSchema = z
  .object({ remaining: z.number().int().nonnegative(), resetAt: z.number().int().nonnegative() })
  .readonly();

export const SnapshotSchema = z
  .object({
    v: z.literal(1),
    updatedAt: z.number().int().nonnegative(),
    issues: z.record(z.string(), ResolutionSchema),
    epics: z.record(z.string(), EpicEntrySchema),
    usage: UsageSchema,
    rateLimit: RateLimitSchema.nullable(),
    error: ErrorCodeSchema.nullable(),
    detail: z.string().max(120).nullable(),
  })
  .readonly();

export type EpicKind = z.infer<typeof EpicKindSchema>;
export type Child = z.infer<typeof ChildSchema>;
export type EpicEntry = z.infer<typeof EpicEntrySchema>;
export type Resolution = z.infer<typeof ResolutionSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
