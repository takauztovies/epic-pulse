import { z } from 'zod';
import { HostSchema } from './common.js';

// One line of the user's usage ledger: the points one GraphQL request was
// charged, when, against which host, and for which registry. `repo` is a hash
// of the registry directory (usage-ledger.ts), so the ledger holds no path.
export const UsageLineSchema = z
  .object({
    ts: z.number().int().nonnegative(),
    host: HostSchema,
    repo: z.string().regex(/^[0-9a-f]{16}$/),
    points: z.number().int().positive(),
  })
  .readonly();

export type UsageLine = z.infer<typeof UsageLineSchema>;
