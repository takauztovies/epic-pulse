import { spawn } from 'node:child_process';
import {
  emptySnapshot, epicRefsOf, gatherRefs, needsFetch, needsResolution,
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
// session's issues or the repository's pins: an issue not resolved yet, a
// resolution past its 30-minute cache or an epic past its 2-minute one. A
// missing or corrupt snapshot caches nothing, so every ref is due. A session
// the hook never wrote for shows "hook inactive" and asks for nothing. For a
// minute after a refresh that failed nothing is due: what it lacked, a token
// or budget, is no likelier to be there on the next render.
export function refreshDue(input: DueInput): boolean {
  if (input.session === undefined || retryingLater(input.attempt, input.now)) return false;
  const refs = gatherRefs([input.session], input.pins, input.now);
  const snapshot = input.snapshot.status === 'ok' ? input.snapshot.snapshot : emptySnapshot(input.now);
  if (needsResolution(snapshot, refs, input.now).length > 0) return true;
  return needsFetch(snapshot, epicRefsOf(snapshot, refs), input.now).length > 0;
}

// Detached and unreferenced: the status line prints and exits at once while the
// refresh runs on, single-flight behind its lock. The registry is handed over
// through EPIC_PULSE_DIR, which also works when no working directory would.
export function spawnRefresh(dir: string, env: NodeJS.ProcessEnv): void {
  try {
    const child = spawn(process.execPath, [bundlePath(), 'refresh'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...env, EPIC_PULSE_DIR: dir },
    });
    child.on('error', () => undefined); // it could not start; the next render tries again
    child.unref();
  } catch {
    // spawn throws when the system is out of processes or descriptors; the
    // status line is already printed, and the next render tries again.
  }
}
