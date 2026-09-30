import { homedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { findWorktree } from './git.js';

export const REGISTRY_DIR_NAME = 'epic-pulse';
const CACHE_DIR_NAME = 'epic-pulse';

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

function homeDirectory(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined; // no HOME and no passwd entry, e.g. an unnamed container user
  }
}

// %LOCALAPPDATA% on Windows, ~/Library/Caches on macOS, and XDG_CACHE_HOME or
// ~/.cache elsewhere. A relative XDG_CACHE_HOME is ignored, as the XDG spec
// says. macOS does not read XDG_CACHE_HOME: a variable set in one shell and not
// in another would split the ledger that every refresher has to share.
function cacheRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string | undefined): string | undefined {
  const path = platform === 'win32' ? win32 : posix;
  const absolute = (name: string) => {
    const value = env[name];
    return value && path.isAbsolute(value) ? value : undefined;
  };
  const under = (...parts: readonly string[]) => (home ? path.join(home, ...parts) : undefined);
  if (platform === 'win32') return absolute('LOCALAPPDATA') ?? under('AppData', 'Local');
  if (platform === 'darwin') return under('Library', 'Caches');
  return absolute('XDG_CACHE_HOME') ?? under('.cache');
}

// Per user, not per repository: the usage ledger every refresher on the
// machine charges lives here. EPIC_PULSE_CACHE_DIR overrides it, for tests and
// for people who want the data elsewhere. Undefined only without a home.
export function cacheDirFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string | undefined): string | undefined {
  const override = env['EPIC_PULSE_CACHE_DIR'];
  if (override) return resolve(override);
  const root = cacheRoot(env, platform, home);
  return root === undefined ? undefined : (platform === 'win32' ? win32 : posix).join(root, CACHE_DIR_NAME);
}

export function userCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  return cacheDirFor(env, process.platform, homeDirectory());
}
