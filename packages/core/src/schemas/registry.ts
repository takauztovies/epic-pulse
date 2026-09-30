import { z } from 'zod';
import { BindViaSchema, IssueRefSchema } from './common.js';

export const BindEntrySchema = z.object({ ref: IssueRefSchema, via: BindViaSchema }).readonly();

// One line per hook invocation, never one per signal: 32 concurrent hooks then
// leave exactly 32 lines, each a single O_APPEND write (atomic below PIPE_BUF).
// The line carries refs and timestamps only. No command text, path or content.
export const RegistryLineSchema = z
  .object({
    v: z.literal(1),
    ts: z.number().int().nonnegative(),
    ev: z.enum(['start', 'tool', 'end']),
    binds: z.array(BindEntrySchema).max(50).default([]),
    unbinds: z.array(IssueRefSchema).max(50).default([]),
  })
  .readonly();

export const PinSchema = z.object({ ref: IssueRefSchema, addedAt: z.number().int().nonnegative() }).readonly();
export const PinsFileSchema = z.object({ v: z.literal(1), pins: z.array(PinSchema).max(200) }).readonly();

export type BindEntry = z.infer<typeof BindEntrySchema>;
export type RegistryLine = z.infer<typeof RegistryLineSchema>;
export type RegistryLineInput = z.input<typeof RegistryLineSchema>;
export type Pin = z.infer<typeof PinSchema>;
export type PinsFile = z.infer<typeof PinsFileSchema>;
