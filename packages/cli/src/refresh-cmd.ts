import { refresh, registryDirFor } from '@epic-pulse/core';
import { parseCommandArgs } from './args.js';
import { failWith, NOT_A_REPO, printLine, usageError } from './io.js';
import { recordAttempt } from './refresh-attempt.js';

// Runs one refresh of the repository's registry now. The status line starts
// the same command detached whenever something is due; by hand it is only
// needed to see the outcome. A refresh already running wins: this one leaves.
// Every refresh that ran is recorded, when it ended and how, for the status
// line to wait on after a failure.
export async function runRefresh(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (!parseCommandArgs(args, {})) return usageError('refresh');
  const dir = await registryDirFor(process.cwd(), env);
  if (dir === undefined) return failWith(NOT_A_REPO);
  const outcome = await refresh({ dir, now: Date.now(), env });
  if (outcome.status === 'busy') {
    printLine('epic-pulse: another refresh is running; leaving it to finish.');
    return 0;
  }
  await recordAttempt(dir, Date.now(), outcome.error);
  printLine(`epic-pulse: refreshed with ${outcome.requests} request(s) and ${outcome.points} point(s).`);
  return outcome.error === null ? 0 : failWith(`the refresh stopped early (${outcome.error})`);
}
