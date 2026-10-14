import { loadProjectFor, pathsFor, readSnapshot, registryDirFor, safeChars, sameProject, BOARD_SCOPE_HINT, type Board, type ProjectConfig } from '@epic-pulse/core';
import { iso, type Check } from './doctor-checks.js';

// The block is the repository's own text (.epic-pulse.json) and doctor writes it
// to a terminal, so a control or bidi character in `field` shows as `?`. Only
// what is printed is cleaned: GitHub is still asked for the field as written.
function named(project: ProjectConfig): string {
  return safeChars(`${project.owner} project ${project.number}, field ${project.field}`);
}

// How the last read went: what it mapped, whether the board was cut at the
// page cap, and the option names that map to nothing, which keep their issues'
// derived status until the repository maps them.
function readState(board: Board): string {
  const items = Object.keys(board.items).length;
  const parts = [
    `${items} ${items === 1 ? 'item' : 'items'} mapped`,
    ...(board.truncated ? ['the board has more items than are read; the rest keep their derived status'] : []),
    ...(board.unmapped.length > 0 ? [`unmapped options: ${board.unmapped.join(', ')} (map them under "statusMap")`] : []),
  ];
  return parts.join('; ');
}

// Where the statuses come from once a read failed. A failure that kept the last
// board's items (network, timeout, rate_limited) leaves them from the read that
// made them, which is older than the failure; any other left none, and so does a
// board that had mapped none, so every issue shows its derived status.
function statusSource(board: Board): string {
  const { readAt, items } = board;
  return readAt !== null && Object.keys(items).length > 0 ? `from the last good read at ${iso(readAt)}` : 'derived';
}

export function boardState(project: ProjectConfig, board: Board | undefined): string {
  if (board === undefined || !sameProject(board.project, project)) return `${named(project)}: not read yet`;
  if (board.error === 'scope') return BOARD_SCOPE_HINT;
  if (board.error !== null) return `${named(project)}: the last read failed (${board.error}); statuses are ${statusSource(board)}`;
  return `${named(project)}: ${readState(board)}`;
}

// One line, and only when the repository configures a board.
export async function boardChecks(cwd: string, env: NodeJS.ProcessEnv): Promise<readonly Check[]> {
  const [project, dir] = await Promise.all([loadProjectFor(cwd), registryDirFor(cwd, env)]);
  if (project === undefined) return [];
  const read = dir === undefined ? undefined : await readSnapshot(pathsFor(dir).snapshotFile);
  return [['board', boardState(project, read?.status === 'ok' ? read.snapshot.board : undefined)]];
}
