import { loadProjectFor, pathsFor, readSnapshot, registryDirFor, sameProject, BOARD_SCOPE_HINT, type Board, type ProjectConfig } from '@epic-pulse/core';
import type { Check } from './doctor-checks.js';

function named(project: ProjectConfig): string {
  return `${project.owner} project ${project.number}, field ${project.field}`;
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

export function boardState(project: ProjectConfig, board: Board | undefined): string {
  if (board === undefined || !sameProject(board.project, project)) return `${named(project)}: not read yet`;
  if (board.error === 'scope') return BOARD_SCOPE_HINT;
  if (board.error !== null) return `${named(project)}: the last read failed (${board.error}); statuses are derived`;
  return `${named(project)}: ${readState(board)}`;
}

// One line, and only when the repository configures a board.
export async function boardChecks(cwd: string, env: NodeJS.ProcessEnv): Promise<readonly Check[]> {
  const [project, dir] = await Promise.all([loadProjectFor(cwd), registryDirFor(cwd, env)]);
  if (project === undefined) return [];
  const read = dir === undefined ? undefined : await readSnapshot(pathsFor(dir).snapshotFile);
  return [['board', boardState(project, read?.status === 'ok' ? read.snapshot.board : undefined)]];
}
