import { mapOption, sameProject } from './board-config.js';
import { boardErrorOf, boardKey, type BoardPage } from './board-query.js';
import type { Failure } from './queries.js';
import { DEFAULT_HOST } from './ref.js';
import { EPIC_TTL_MS } from './refresh-plan.js';
import { BOARD_LIMITS, type Board, type BoardError, type ProjectConfig } from './schemas/board.js';
import type { Status } from './schemas/common.js';
import type { SubIssueNode } from './schemas/graphql.js';
import type { Child, Snapshot } from './schemas/snapshot.js';

// Pure board logic: when to read the board, what a read leaves in the
// snapshot, and what an item's status is once the board is known. The fetch
// itself is board-fetch.ts.

// A project block names an owner and a number, not a host: boards are read
// from github.com, and only for epics there.
export const BOARD_HOST = DEFAULT_HOST;
// Pages of BOARD_PAGE_SIZE items. A larger board is read this far, flagged
// `truncated`, and its other items keep their derived status.
export const BOARD_MAX_PAGES = 5;
// A refusal that asking again soon would not change (no read:project, no such
// project) waits this long; anything else is asked again with the epics.
export const BOARD_RETRY_MS = 30 * 60 * 1000;
const TRANSIENT: ReadonlySet<BoardError> = new Set(['network', 'timeout', 'rate_limited']);

// Where the next page starts, or undefined when there is none or the cap is
// reached. `pages`: how many have been read so far, this one included.
export function nextCursor(page: BoardPage, pages: number): string | undefined {
  return page.next !== null && pages < BOARD_MAX_PAGES ? page.next : undefined;
}

// The pages as one board entry. An item whose option maps to nothing is left
// out, so it keeps its derived status; its option name is kept for doctor.
export function boardEntry(project: ProjectConfig, pages: readonly BoardPage[], now: number): Board {
  const items = pages.flatMap((page) => page.items).slice(0, BOARD_LIMITS.maxItems);
  const mapped = items.flatMap((item) => {
    const status = item.option === null ? undefined : mapOption(project, item.option);
    return status === undefined ? [] : [[item.key, status] as const];
  });
  const unmapped = items.flatMap((item) => (item.option !== null && mapOption(project, item.option) === undefined ? [item.option.slice(0, BOARD_LIMITS.maxNameLength)] : []));
  const truncated = (pages.at(-1)?.next ?? null) !== null;
  return { project, fetchedAt: now, readAt: now, error: null, truncated, items: Object.fromEntries(mapped), unmapped: [...new Set(unmapped)].slice(0, BOARD_LIMITS.maxUnmapped) };
}

// A failed read. A transient one keeps what was read before, and when; any other
// leaves no items, so every issue shows its derived status until a read succeeds.
// `fetchedAt` is this attempt's, so only `readAt` still says how old the items are.
export function boardFailed(previous: Board | undefined, project: ProjectConfig, failure: { readonly failure: Failure; readonly now: number }): Board {
  const error = boardErrorOf(failure.failure);
  const kept = TRANSIENT.has(error) && previous ? previous : undefined;
  return { project, fetchedAt: failure.now, readAt: kept?.readAt ?? null, error, truncated: kept?.truncated ?? false, items: kept?.items ?? {}, unmapped: kept?.unmapped ?? [] };
}

// The board is read with the epics (EPIC_TTL_MS), and a lasting refusal is
// asked again after BOARD_RETRY_MS.
export function boardDue(board: Board | undefined, now: number): boolean {
  if (board === undefined) return true;
  const ttl = board.error !== null && !TRANSIENT.has(board.error) ? BOARD_RETRY_MS : EPIC_TTL_MS;
  return now - board.fetchedAt >= ttl || now < board.fetchedAt;
}

// The snapshot's board only if it is this project block's: a block that was
// removed or changed leaves none, so nothing is read through a stale map.
export function boardFor(snapshot: Snapshot, project: ProjectConfig | undefined): Snapshot {
  const { board, ...rest } = snapshot;
  return board === undefined || (project !== undefined && sameProject(board.project, project)) ? snapshot : rest;
}

// Precedence. A closed issue keeps its derived status (done or dropped, from how
// it was closed): a board can not reopen it. An open issue on the board under a
// mapped option takes that status, done and dropped included; a board `dropped`
// leaves the denominator as a not-planned close does. Anything else keeps the
// derived status. Without a board there is no source to record.
export function withBoardStatus(node: SubIssueNode, derived: Status, items: Board['items'] | undefined): Pick<Child, 'status' | 'statusSource'> {
  if (items === undefined) return { status: derived };
  const onBoard = node.state === 'CLOSED' ? undefined : items[boardKey(node.repository.nameWithOwner, node.number)];
  return onBoard === undefined ? { status: derived, statusSource: 'derived' } : { status: onBoard, statusSource: 'board' };
}

// What doctor and the VS Code extension say when the token can not read the
// board, and how to give it the scope.
export const BOARD_SCOPE_HINT = 'token lacks read:project — `gh auth refresh -s read:project`';
