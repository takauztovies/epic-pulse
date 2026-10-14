import { z } from 'zod';
import { ERROR_CODES, IssueNumberSchema, OwnerSchema, safeText, StatusSchema } from './common.js';

// GitHub Project (v2) board Status, opt-in through the `project` block of
// `.epic-pulse.json` (board-config.ts). Everything here crosses a boundary: the
// project block is untrusted repository data, the board answer is GitHub's, and
// the board entry is read back from the snapshot file.

export const BOARD_LIMITS = { maxFieldLength: 100, maxNameLength: 100, maxStatusMap: 60, maxItems: 500, maxUnmapped: 20, maxTimeMs: 8.64e15 } as const;

// The project block once checked: whose project, its number, which single-select
// field holds the status, and the repository's own option-name overrides, keyed
// by normalised name (board-config.ts normaliseOption).
export const ProjectConfigSchema = z
  .object({
    owner: OwnerSchema,
    number: IssueNumberSchema,
    field: z.string().min(1).max(BOARD_LIMITS.maxFieldLength),
    statusMap: z.record(z.string().max(BOARD_LIMITS.maxNameLength), StatusSchema).readonly(),
  })
  .readonly();

// `scope`: the token can not read projects (INSUFFICIENT_SCOPES or FORBIDDEN).
// Any other refusal carries the code it would carry anywhere else.
export const BoardErrorSchema = z.enum(['scope', ...ERROR_CODES]);

// The board as last fetched, for the project it was fetched for: a board for
// another project block is dropped when a refresh starts (board.ts boardFor).
// `items`: `owner/repo#N`, lowercased, to the status its option maps to; an item
// whose option maps to nothing is not here, its option name is in `unmapped`
// (for `epic-pulse doctor`). `truncated`: the board had more pages than are read.
// Doctor prints those names, so they pass safeText here too, not only where
// GitHub's answer is read: an older version stored them as GitHub sent them.
// `fetchedAt` is the last attempt, which paces the next (board.ts boardDue), so
// after a failure it is the failure's. `readAt` is when `items` were last read:
// after a failure that kept them, the read before it, so doctor can say how old
// the statuses are; null where no read is held. Doctor prints it as a date, and
// a Date holds nothing past `maxTimeMs` (toISOString throws), so a corrupt one
// makes the entry malformed, which reads as no board. So does an entry written
// before `readAt` existed: it has no time to say its items are from, and it is
// read again with the epics.
export const BoardSchema = z
  .object({
    project: ProjectConfigSchema,
    fetchedAt: z.number().int().nonnegative(),
    readAt: z.number().int().nonnegative().max(BOARD_LIMITS.maxTimeMs).nullable(),
    error: BoardErrorSchema.nullable(),
    truncated: z.boolean(),
    items: z
      .record(z.string().max(250), StatusSchema)
      .refine((items) => Object.keys(items).length <= BOARD_LIMITS.maxItems)
      .readonly(),
    unmapped: z.array(safeText(BOARD_LIMITS.maxNameLength)).max(BOARD_LIMITS.maxUnmapped).readonly(),
  })
  .readonly();

// One board item as GitHub answers it. `content` is `{}` for a pull request or a
// draft issue, and the field value `{}` when the field is not a single select;
// both read as "not on the board" rather than as a broken answer. An option's
// name is whatever the board's editors typed (safeText).
const BoardItemNodeSchema = z.object({
  content: z
    .looseObject({ number: IssueNumberSchema.optional(), repository: z.object({ nameWithOwner: z.string() }).optional() })
    .nullable(),
  fieldValueByName: z.looseObject({ name: safeText(BOARD_LIMITS.maxNameLength).optional() }).nullable(),
});

export const BoardDataSchema = z.object({
  repositoryOwner: z
    .object({
      projectV2: z
        .object({
          items: z.object({
            nodes: z.array(BoardItemNodeSchema.nullable()),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type BoardError = z.infer<typeof BoardErrorSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type BoardItemNode = z.infer<typeof BoardItemNodeSchema>;
