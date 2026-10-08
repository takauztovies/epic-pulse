import type { Batch } from './refresh-batch.js';
import type { Failure, RateInfo } from './queries.js';
import type { RawResponse } from './github.js';
import type { Result } from './result.js';
import type { Snapshot } from './schemas/snapshot.js';
import { GITHUB } from './provider-github.js';

// What the refresher needs from an issue tracker, and nothing else: find a
// token for a host, send one batch (Phase A resolves issues to epics, Phase B
// fetches epics with their children), and turn the answer into snapshot
// updates plus what it cost. Registry, pins, the view, rendering, the lock and
// the budget are shared by every provider.
export type ProviderKind = 'github';

export interface Parsed {
  readonly rate: RateInfo | null;
  readonly apply: (snapshot: Snapshot, now: number) => Snapshot;
}

export interface Provider {
  readonly kind: ProviderKind;
  token(host: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  send(token: string, batch: Batch): Promise<Result<RawResponse, Failure>>;
  parse(batch: Batch, response: RawResponse): Result<Parsed, Failure>;
}

// Every repository is GitHub today. When a second provider exists this takes
// the repository and chooses by host and configuration (docs/design/providers.md).
export function providerFor(): Provider {
  return GITHUB;
}
