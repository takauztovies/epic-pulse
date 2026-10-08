import type { Batch } from './refresh-batch.js';
import type { Failure, RateInfo } from './queries.js';
import type { RawResponse } from './github.js';
import type { Result } from './result.js';
import type { IssueRef, RepoRef } from './schemas/common.js';
import type { Snapshot } from './schemas/snapshot.js';
import type { JiraConfig } from './jira-config.js';

import { GITHUB } from './provider-github.js';
import { JIRA } from './provider-jira.js';
import { kindOf } from './ref.js';

// What the refresher needs from an issue tracker, and nothing else: find a
// token for a host, send one batch (Phase A resolves issues to epics, Phase B
// fetches epics with their children), and turn the answer into snapshot
// updates plus what it cost. Registry, pins, the view, rendering, the lock and
// the budget are shared by every provider.
export type ProviderKind = 'github' | 'jira';

// What a repository says about its tracker, passed to parse: Jira's workflow
// has no fixed meaning, so its statuses are mapped by the repository's own jira
// block. GitHub needs none.
export interface ProviderSettings {
  readonly jira?: JiraConfig | undefined;
}

export interface Parsed {
  readonly rate: RateInfo | null;
  readonly apply: (snapshot: Snapshot, now: number) => Snapshot;
}

export interface Provider {
  readonly kind: ProviderKind;
  token(host: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  send(token: string, batch: Batch): Promise<Result<RawResponse, Failure>>;
  parse(batch: Batch, response: RawResponse, settings: ProviderSettings): Result<Parsed, Failure>;
}

// The tracker a repository's references belong to.
export function providerFor(repo: RepoRef | IssueRef): Provider {
  return kindOf(repo) === 'jira' ? JIRA : GITHUB;
}
