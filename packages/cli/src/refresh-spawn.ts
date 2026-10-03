import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  emptySnapshot, epicsToWatch, gatherRefs, homeDirectory, needsFetch, needsResolution, pinnedRefs, REFRESH_SESSION_ENV, withSession,
  type Pin, type SessionState, type SnapshotRead,
} from '@epic-pulse/core';
import { retryingLater, type RefreshAttempt } from './refresh-attempt.js';
import { bundlePath } from './runtime.js';

export interface DueInput {
  readonly snapshot: SnapshotRead;
  readonly session: SessionState | undefined;
  readonly pins: readonly Pin[];
  readonly now: number;
  // The CLI's last refresh of the registry, when there was one.
  readonly attempt?: RefreshAttempt;
}

// Due exactly when the refresher would ask GitHub something about this
// session's issues, live or not, or the repository's pins: an issue not
// resolved yet, a resolution past its 30-minute cache or an epic past its
// 2-minute one, a pinned issue not yet asked about as an epic of its own. A
// missing or corrupt snapshot caches nothing, so every ref is
// due. A session the hook never wrote for shows "hook inactive" and asks for
// nothing. For a minute after a refresh that failed nothing is due: what it
// lacked, a token or budget, is no likelier to be there on the next render.
export function refreshDue(input: DueInput): boolean {
  if (input.session === undefined || retryingLater(input.attempt, input.now)) return false;
  const refs = withSession(gatherRefs([], input.pins, input.now), input.session, input.now);
  const snapshot = input.snapshot.status === 'ok' ? input.snapshot.snapshot : emptySnapshot(input.now);
  if (needsResolution(snapshot, refs, input.now).length > 0) return true;
  const pinned = pinnedRefs([input.session], input.pins, input.now);
  return needsFetch(snapshot, epicsToWatch(snapshot, refs, pinned), input.now).length > 0;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Where a detached process starts: not in the directory the status line was
// started in, which is the repository. On Windows a running process keeps its
// working directory from being removed (EBUSY), so a refresh started there held
// a worktree, a checkout or a test's temp copy for as long as it ran. The home
// directory, which nobody removes, else the temp directory for an account that
// has none: a working directory that is not there stops the process from
// starting at all. With neither, it inherits its parent's, as it always did.
function neutralDirectory(): string | undefined {
  return [homeDirectory(), tmpdir()].find((path) => path !== undefined && isDirectory(path));
}

// A process that outlives this one: detached and unreferenced, its output
// ignored, so the caller prints and exits at once while it runs on.
export function spawnDetached(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: neutralDirectory(), env });
    child.on('error', () => undefined); // it could not start; the next render tries again
    child.unref();
  } catch {
    // spawn throws when the system is out of processes or descriptors; the
    // status line is already printed, and the next render tries again.
  }
}

// The refresh runs on single-flight behind its lock. The registry is handed
// over through EPIC_PULSE_DIR, which also works when no working directory
// would, and the status line's own session, whose issues the refresh then keeps
// current even when the session is not live, through EPIC_PULSE_SESSION.
export function spawnRefresh(dir: string, env: NodeJS.ProcessEnv, session?: string): void {
  spawnDetached(process.execPath, [bundlePath(), 'refresh'], { ...env, EPIC_PULSE_DIR: dir, [REFRESH_SESSION_ENV]: session ?? '' });
}
