import { z } from 'zod';

// `.epic-pulse.json` is data from whatever repository the user happens to have
// open, so it is untrusted. Size and length limits live here; a field that fails
// its check falls back to the default rather than voiding the whole file.
export const CONFIG_LIMITS = {
  maxFileBytes: 64 * 1024,
  maxPatternLength: 200,
  maxIgnorePaths: 100,
  maxIgnorePathLength: 200,
} as const;

export const RawConfigSchema = z.looseObject({
  branchIssuePattern: z.string().optional().catch(undefined),
  ignorePaths: z.array(z.unknown()).optional().catch(undefined),
  ignoreMainCheckout: z.boolean().optional().catch(undefined),
});

export type RawConfig = z.infer<typeof RawConfigSchema>;
