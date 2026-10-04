import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RegistryPaths } from '@epic-pulse/core';

// When a hook last wrote for any session of the repository: the newest session
// file's mtime, or undefined when no hook has ever written here.
export async function lastHookActivity(paths: RegistryPaths): Promise<number | undefined> {
  const names = await readdir(paths.sessionsDir).catch(() => [] as string[]);
  const times = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => stat(join(paths.sessionsDir, name)).then((info) => info.mtimeMs, () => 0)),
  );
  const newest = times.reduce((latest, time) => Math.max(latest, time), 0);
  return newest > 0 ? newest : undefined;
}
