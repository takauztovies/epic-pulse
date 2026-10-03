import { refresh, registryDirFor } from '@epic-pulse/core';
import { parseCommandArgs } from './args.js';
import { failWith, NOT_A_REPO, printLine, usageError } from './io.js';
import { recordAttempt } from './refresh-attempt.js';

// Held back only by pacing: cached data waits for this repository's turn in the
// hour every refresher shares. Nothing is wrong, so it is not a failure, but the
// record still says `budget`, as it did when this was reported as one: that is
// what keeps the status line from starting another refresh at every render.
async function waitingItsTurn(dir: string, until: number): Promise<number> {
  const now = Date.now();
  await recordAttempt(dir, now, 'budget');
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  printLine(`epic-pulse: this repository's refresh is waiting for its turn in the shared hourly budget; the next one can run at ${new Date(until).toISOString()} (in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}).`);
  return 0;
}

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
  if (outcome.status === 'paced') return waitingItsTurn(dir, outcome.until);
  if (outcome.status === 'busy') {
    printLine('epic-pulse: another refresh is running; leaving it to finish.');
    return 0;
  }
  await recordAttempt(dir, Date.now(), outcome.error);
  printLine(`epic-pulse: refreshed with ${outcome.requests} request(s) and ${outcome.points} point(s).`);
  return outcome.error === null ? 0 : failWith(`the refresh stopped early (${outcome.error})`);
}
