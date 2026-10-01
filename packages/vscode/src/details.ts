import type { TokenUse } from './grant.js';
import { progressText } from './labels.js';
import { repoState } from './model.js';
import type { RefreshSummary, RepoResult } from './poll.js';

// Text for the "Show status details" command and the log, both in the Epic
// Pulse output channel, which VS Code keeps on disk. So: codes, counts, labels
// and local paths only. No token, no issue title, no library message.

// Which VS Code sign-ins exist, by host. A token has no field here.
export interface Accounts {
  readonly github: boolean;
  readonly enterprise: string | null;
}

export interface DetailsInput {
  readonly results: readonly RepoResult[];
  readonly accounts: Accounts;
  readonly now: number;
}

const TOKEN_TEXT: Readonly<Record<TokenUse, string>> = {
  session: 'from the VS Code sign-in, for the host it belongs to; any other host as the CLI does',
  none: 'GH_TOKEN or `gh auth token`, as the CLI does: no VS Code sign-in covers this repository',
};

export function refreshText(summary: RefreshSummary): string {
  switch (summary.status) {
    case 'skipped':
      return 'skipped, the registry does not exist yet';
    case 'failed':
      return 'failed, the registry could not be written';
    case 'busy':
      return 'left to another refresher, which holds the lock';
    case 'done':
      return `${summary.requests} requests, ${summary.points} points, error ${summary.error ?? 'none'}`;
  }
}

function repoLines(result: RepoResult): readonly string[] {
  const { snapshot, liveSessions, epics } = result.view;
  return [
    '',
    result.repo.label,
    `  registry: ${result.repo.dir}`,
    `  hook: ${result.hookSeen ? 'has written here' : 'has not written here in the last week'}`,
    `  state: ${repoState(result)}${snapshot.error === null ? '' : ` (${snapshot.error})`}`,
    `  live sessions: ${liveSessions}`,
    `  snapshot written: ${snapshot.fetchedAt ?? 'never'}`,
    `  last refresh: ${refreshText(result.refresh)}`,
    `  token: ${TOKEN_TEXT[result.token]}`,
    ...epics.map((epic) => `  epic #${epic.number}: ${progressText(epic)}${epic.stale ? ', stale' : ''}`),
  ];
}

export function detailsText(input: DetailsInput): string {
  const { github, enterprise } = input.accounts;
  const repos = input.results.length;
  return [
    `Epic Pulse status at ${new Date(input.now).toISOString()}`,
    `VS Code sign-in: github.com ${github ? 'yes' : 'no'}, GitHub Enterprise ${enterprise ?? 'no'}`,
    repos === 0 ? 'No workspace folder is inside a git repository.' : `${repos} ${repos === 1 ? 'repository' : 'repositories'}`,
    ...input.results.flatMap(repoLines),
  ].join('\n');
}

// One log line per repository and refresh.
export function outcomeLine(result: RepoResult): string {
  return `${result.repo.label}: refresh ${refreshText(result.refresh)}; token ${result.token}; state ${repoState(result)}`;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

// A thrown value as its class name and errno-style code, never its message:
// a library message can echo what it was given, a header with a token in it
// included (see describeFetchError in core).
export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const name = SAFE_NAME.test(error.name) ? error.name : 'Error';
  const code = 'code' in error && typeof error.code === 'string' && SAFE_CODE.test(error.code) ? ` ${error.code}` : '';
  return `${name}${code}`;
}
