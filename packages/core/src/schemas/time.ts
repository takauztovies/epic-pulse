import { z } from 'zod';

// What the registry keeps of how long sessions worked on each issue: per
// session, how far its lines have been counted, and per issue a running
// total. References and numbers only; no command text, path or content.
export const TimeRefSchema = z
  .object({
    // Active session time in milliseconds.
    ms: z.number().int().nonnegative(),
    // The last time a session was on this issue, and which session.
    lastTs: z.number().int().nonnegative(),
    lastSession: z.string().max(64),
  })
  .readonly();

export const TimeFileSchema = z
  .object({
    v: z.literal(1),
    // Session id -> the timestamp of its last counted line.
    sessions: z.record(z.string(), z.number().int().nonnegative()).readonly(),
    // refKey -> its total.
    refs: z.record(z.string(), TimeRefSchema).readonly(),
  })
  .readonly();

export type TimeRef = z.infer<typeof TimeRefSchema>;
export type TimeFile = z.infer<typeof TimeFileSchema>;
