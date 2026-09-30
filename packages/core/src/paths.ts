import { join, resolve } from 'node:path';
import { findWorktree } from './git.js';

export const REGISTRY_DIR_NAME = 'epic-pulse';

export interface RegistryPaths {
  readonly dir: string;
  readonly sessionsDir: string;
  readonly pinsFile: string;
  readonly snapshotFile: string;
  readonly lockFile: string;
}

export function pathsFor(dir: string): RegistryPaths {
  return {
    dir,
    sessionsDir: join(dir, 'sessions'),
    pinsFile: join(dir, 'pins.json'),
    snapshotFile: join(dir, 'snapshot.json'),
    lockFile: join(dir, 'refresh.lock'),
  };
}

// The registry lives inside `.git`, so it is shared by every worktree of a
// repository and never shows up in `git status`. EPIC_PULSE_DIR overrides that
// for tests and for people who want the data elsewhere.
export async function registryDirFor(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const override = env['EPIC_PULSE_DIR'];
  if (override) return resolve(override);
  const worktree = await findWorktree(cwd);
  return worktree ? join(worktree.commonDir, REGISTRY_DIR_NAME) : undefined;
}
