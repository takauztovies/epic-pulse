import { boardDocument, parseBoardPage, type BoardPage } from './board-query.js';
import { BOARD_HOST, boardDue, boardEntry, boardFailed, nextCursor } from './board.js';
import { describeFetchError, postGraphql } from './github.js';
import { touchLock } from './lock.js';
import type { Failure } from './queries.js';
import { chargePoints, rateLimited } from './refresh-apply.js';
import { overBudget, type Context, type Run } from './refresh-batch.js';
import { fail, type Result } from './result.js';
import type { ProjectConfig } from './schemas/board.js';
import type { IssueRef } from './schemas/common.js';
import { reserveUsage } from './usage-ledger.js';

// The board read, a run step of its own between Phase A and Phase B: the epics
// fetched next take their open sub-issues' status from it (refresh-apply.ts).
// It never fails the run: a refusal is kept on the board entry, the run's own
// failure stays Phase A's or Phase B's, and every issue keeps the status it
// would have had without a board. Each page is one point, reserved in the
// usage ledger and charged to the snapshot's hour like any request.
export const BOARD_PAGE_COST = 1;

interface PageRequest {
  readonly token: string;
  readonly project: ProjectConfig;
  readonly after: string | undefined;
}

async function sendPage(request: PageRequest): Promise<Result<BoardPage, Failure>> {
  const { project, after } = request;
  const variables = { owner: project.owner, field: project.field, ...(after === undefined ? {} : { after }) };
  try {
    return parseBoardPage(await postGraphql({ host: BOARD_HOST, token: request.token, query: boardDocument(project.number), variables }));
  } catch (error) {
    return fail(describeFetchError(error));
  }
}

// A page the budget can not pay for is not asked for: undefined, and the board
// is left as it was, to be read on a later run.
async function admitted(run: Run, ctx: Context): Promise<Run | undefined> {
  if (overBudget(run, BOARD_PAGE_COST)) return undefined;
  if (!ctx.ledger) return run;
  const outcome = await reserveUsage(ctx.ledger, { ts: run.now, host: BOARD_HOST, points: BOARD_PAGE_COST }, ctx.clock());
  return outcome.granted ? { ...run, spent: outcome.spent ?? run.spent } : undefined;
}

async function onePage(run: Run, request: PageRequest, ctx: Context): Promise<{ readonly run: Run; readonly page?: Result<BoardPage, Failure> }> {
  const reserved = await admitted(run, ctx);
  if (reserved === undefined) return { run };
  const page = await sendPage(request);
  await touchLock(ctx.lock, ctx.clock());
  const limited = !page.ok && page.error.code === 'rate_limited' ? rateLimited(reserved.snapshot, run.now) : reserved.snapshot;
  const snapshot = chargePoints(limited, BOARD_PAGE_COST);
  return { run: { ...reserved, snapshot, requests: reserved.requests + 1, points: reserved.points + BOARD_PAGE_COST }, page };
}

function settled(run: Run, board: NonNullable<Run['snapshot']['board']>): Run {
  return { ...run, snapshot: { ...run.snapshot, board } };
}

// Page after page, up to BOARD_MAX_PAGES (nextCursor).
async function readBoard(run: Run, auth: Omit<PageRequest, 'after'>, ctx: Context): Promise<Run> {
  let current = run;
  let pages: readonly BoardPage[] = [];
  let after: string | undefined;
  do {
    const step = await onePage(current, { ...auth, after }, ctx);
    current = step.run;
    if (step.page === undefined) return current;
    if (!step.page.ok) return settled(current, boardFailed(current.snapshot.board, auth.project, { failure: step.page.error, now: run.now }));
    pages = [...pages, step.page.value];
    after = nextCursor(step.page.value, pages.length);
  } while (after !== undefined);
  return settled(current, boardEntry(auth.project, pages, run.now));
}

// Read only when a project block is configured, the board is due, an epic on
// its host is about to be fetched (nothing else would use it), and that host
// has a token. `targets`: the epics Phase B is about to fetch.
export async function runBoard(run: Run, targets: readonly IssueRef[], ctx: Context): Promise<Run> {
  const { project } = ctx;
  if (project === undefined || !boardDue(run.snapshot.board, run.now)) return run;
  const token = ctx.tokens.get(BOARD_HOST);
  if (token === undefined || !targets.some((ref) => ref.host === BOARD_HOST && ref.kind !== 'jira')) return run;
  return readBoard(run, { token, project }, ctx);
}
