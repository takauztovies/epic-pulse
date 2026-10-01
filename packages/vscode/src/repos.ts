import { basename } from 'node:path';
import { registryDirFor } from '@epic-pulse/core';

export interface RepoTarget {
  // The registry directory inside the repository's git common dir.
  readonly dir: string;
  // A name to show for it: the base name of the first folder that led to it.
  readonly label: string;
}

// Every workspace folder inside a git repository leads to that repository's
// registry. Worktrees of one repository share it, and so do nested folders, so
// each registry is listed once, in folder order, under its first folder.
export async function discoverRepos(folders: readonly string[], env: NodeJS.ProcessEnv): Promise<readonly RepoTarget[]> {
  const found = await Promise.all(folders.map(async (folder) => ({ folder, dir: await registryDirFor(folder, env) })));
  const targets = found.flatMap(({ folder, dir }) => (dir === undefined ? [] : [{ dir, label: basename(folder) }]));
  return targets.filter((target, index) => targets.findIndex((other) => other.dir === target.dir) === index);
}
