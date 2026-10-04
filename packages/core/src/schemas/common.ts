import { z } from 'zod';

// Every identifier that ends up in a URL, a GraphQL variable or a file name is
// validated against a narrow charset first. Refs come from remotes, commit
// messages and payloads, all of which are attacker-influenced text.
export const HostSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/);
export const OwnerSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
// `.` and `..` are legal by the charset but never real repo names.
export const RepoSchema = z
  .string()
  .regex(/^[a-z0-9._-]{1,100}$/)
  .refine((name) => name !== '.' && name !== '..');

export const IssueNumberSchema = z.number().int().positive().max(2_147_483_647);

export const RepoRefSchema = z.object({ host: HostSchema, owner: OwnerSchema, repo: RepoSchema }).readonly();
export const IssueRefSchema = z
  .object({ host: HostSchema, owner: OwnerSchema, repo: RepoSchema, number: IssueNumberSchema })
  .readonly();

export const STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'dropped'] as const;
export const StatusSchema = z.enum(STATUSES);
export const StatusCountsSchema = z
  .object({
    todo: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    in_review: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .readonly();

// Codes, never free text: an error that is persisted or printed carries one of
// these plus a whitelisted detail (see github.ts), so a library message that
// echoes a header can not reach disk.
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'rate_limited',
  'budget',
  'network',
  'timeout',
  'not_found',
  'unsupported',
  'invalid_response',
  'invalid_token',
  'no_token',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const STATE_KINDS = ['ok', 'none', 'loading', 'stale', 'error', 'hook-inactive', 'unsupported'] as const;
export const StateKindSchema = z.enum(STATE_KINDS);

export const BIND_VIAS = ['gh', 'closing', 'branch', 'pin'] as const;
export const BindViaSchema = z.enum(BIND_VIAS);

export type Host = z.infer<typeof HostSchema>;
export type RepoRef = z.infer<typeof RepoRefSchema>;
export type IssueRef = z.infer<typeof IssueRefSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type StatusCounts = z.infer<typeof StatusCountsSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type StateKind = z.infer<typeof StateKindSchema>;
export type BindVia = z.infer<typeof BindViaSchema>;
