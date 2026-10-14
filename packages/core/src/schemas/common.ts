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

// Free text that is stored and then printed: titles, an epic's summary, an
// assignee's name, and a project board's option names, which doctor writes to a
// terminal. Whoever can edit the issue, the profile or the board chooses it, so
// a control character (C0, DEL or C1) could start an escape sequence, a bidi
// control could reorder what a line says (U+061C, the Arabic letter mark, does
// as U+200E and U+200F do), and a line or paragraph separator (U+2028, U+2029)
// starts a line of its own in a terminal or an editor that follows the Unicode
// line-break rules: each becomes `?`. The rest of \p{Cf} is left alone: an
// emoji needs its ZWJ (U+200D), as it does its VS16 (U+FE0F).
const UNSAFE_CHARS = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

// The character pass alone, for text that is cut its own way (hosts.ts).
export function safeChars(text: string): string {
  return text.replace(UNSAFE_CHARS, '?');
}

// A cap counts UTF-16 units, so a cut can fall between the two halves of an
// emoji and keep the first: a lone surrogate, which is not text and which a
// terminal or a file shows as U+FFFD. That half goes too, so the text is never
// longer than the cap and never ends in half a character. It goes whether or not
// this cut made it: buildEpic (resolve.ts) slices a title at 300 units before the
// snapshot parses it, so by then the text is at the cap and nothing is cut here.
const HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/;

// The pass, then a cap at `max` rather than a refusal, so one long title can
// not void the snapshot that holds it.
export function safeText(max: number): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> {
  return z.string().transform((text) => safeChars(text).slice(0, max).replace(HIGH_SURROGATE_AT_END, ''));
}

// Which tracker a reference belongs to. Absent means GitHub, so every file
// written before this field existed stays valid, byte for byte, and a GitHub
// reference is still written without it. A Jira reference has the same four
// fields: `host` is the site, `owner` and `repo` are both the lowercased
// project key, `number` is the issue's number (PROJ-123 is project `proj`,
// number 123). refKey, repoKey, issueUrl and displayKey (ref.ts) are what
// tell them apart.
export const REF_KINDS = ['github', 'jira'] as const;
export const RefKindSchema = z.enum(REF_KINDS);

export const RepoRefSchema = z.object({ kind: RefKindSchema.optional(), host: HostSchema, owner: OwnerSchema, repo: RepoSchema }).readonly();
export const IssueRefSchema = z
  .object({ kind: RefKindSchema.optional(), host: HostSchema, owner: OwnerSchema, repo: RepoSchema, number: IssueNumberSchema })
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

export type RefKind = z.infer<typeof RefKindSchema>;

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
