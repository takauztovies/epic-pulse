import type { JsonEpic, JsonV1 } from './schemas/json-v1.js';

// One line for Claude Code's status line, from a view that is already scoped
// to the session: its first epic in full, the rest as a count.
//   #1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)

export interface RenderOptions {
  readonly width?: number;
  // Colour the bar's cells by status with ANSI codes. Off unless asked for, so
  // the line stays the plain text it always was; this module reads no
  // environment, so the caller reads NO_COLOR and says.
  readonly color?: boolean;
}

const BAR_CELLS = 10;
const DEFAULT_WIDTH = 80;
const FILLED = '▓';
const EMPTY = '░';

// Done is green, In review cyan, In progress yellow; what no status claims is dim.
const PAINT = { done: '\x1b[32m', review: '\x1b[36m', progress: '\x1b[33m', rest: '\x1b[2m' } as const;
const RESET = '\x1b[0m';

// Every state without an epic to show says what it is; no state is a blank line.
const STATE_TEXT = {
  'hook-inactive': 'epic-pulse: hook inactive',
  none: 'epic-pulse: no epic',
  loading: 'epic-pulse: loading…',
  unsupported: 'epic-pulse: unsupported host (no sub-issues)',
} as const;

function widthOf(width: number | undefined): number {
  return width !== undefined && Number.isFinite(width) && width >= 1 ? Math.floor(width) : DEFAULT_WIDTH;
}

function filledCells(percent: number): number {
  return Math.min(BAR_CELLS, Math.max(0, Math.floor((percent * BAR_CELLS) / 100)));
}

// Closed work only: floored like the percent, so a full bar only ever means a
// finished epic. weightedPercent (the repository's configured credit for work
// in flight) stays in the JSON view; it does not drive this bar, so the bar
// never looks ahead of what is actually Done.
function bar(percent: number): string {
  const filled = filledCells(percent);
  return `${FILLED.repeat(filled)}${EMPTY.repeat(BAR_CELLS - filled)}`;
}

// The same cells, by status. Done fills what bar() fills; the cells left are
// shared out by the items still open, each share rounded down so that work in
// flight never looks like more than there is, and what no share claims (the
// todo items, and the rounding) is dim. The characters are bar()'s own: only
// the escape codes are new, and they take no width.
function paintedBar(epic: JsonEpic): string {
  const { in_review: review, in_progress: progress, todo } = epic.counts;
  const done = filledCells(epic.percent);
  const open = BAR_CELLS - done;
  const share = (count: number) => Math.floor((open * count) / Math.max(1, review + progress + todo));
  const [reviewing, working] = [share(review), share(progress)];
  const runs = [
    [PAINT.done, FILLED.repeat(done)], [PAINT.review, EMPTY.repeat(reviewing)],
    [PAINT.progress, EMPTY.repeat(working)], [PAINT.rest, EMPTY.repeat(open - reviewing - working)],
  ] as const;
  return runs.filter(([, cells]) => cells.length > 0).map(([paint, cells]) => `${paint}${cells}${RESET}`).join('');
}

// The line is fitted before it is painted, so the codes can neither push it
// past the width nor be cut in half. Only its widest variant has the bar in
// it: a line cut narrower has nothing to paint and comes back as it was.
function withColor(line: string, epic: JsonEpic): string {
  return line.replace(bar(epic.percent), () => paintedBar(epic));
}

// done / countable: dropped work leaves the denominator, as in percentDone.
function fraction(epic: JsonEpic): string {
  const total = Object.values(epic.counts).reduce((sum, n) => sum + n, 0);
  return `${epic.counts.done}/${total - epic.counts.dropped}${epic.truncated ? '+' : ''}`;
}

// The first variant that fits; failing that, the shortest, cut with an ellipsis.
function fit(variants: readonly string[], width: number): string {
  const fitting = variants.find((line) => line.length <= width);
  if (fitting !== undefined) return fitting;
  const shortest = variants.at(-1) ?? '';
  return width <= 1 ? shortest.slice(0, width) : `${shortest.slice(0, width - 1)}…`;
}

// Detail goes before anything is cut: first the bar, then review and progress
// counts, then the loading count and the other-epics count. The stale marker is
// in every variant.
function epicLine(epic: JsonEpic, options: { readonly more: number; readonly pending: number; readonly width: number }): string {
  const { in_review: review, in_progress: progress } = epic.counts;
  const detail = [review > 0 ? `rev ${review}` : '', progress > 0 ? `wip ${progress}` : ''].filter(Boolean);
  const stale = epic.stale ? [epic.error === null ? 'stale' : `stale (${epic.error})`] : [];
  const loading = options.pending > 0 ? [`${options.pending} loading`] : [];
  const extra = options.more > 0 ? ` (+${options.more})` : '';
  const head = `${epic.key} ${epic.percent}% ${fraction(epic)}`;
  const withBar = `${epic.key} ${bar(epic.percent)} ${epic.percent}% ${fraction(epic)}`;
  return fit([
    [withBar, ...detail, ...stale, ...loading].join(' · ') + extra,
    [head, ...detail, ...stale, ...loading].join(' · ') + extra,
    [head, ...stale, ...loading].join(' · ') + extra,
    [`${epic.key} ${epic.percent}%`, ...stale].join(' · '),
  ], options.width);
}

function stateText(view: JsonV1): string {
  const { state, error } = view.snapshot;
  if (state === 'error') return `epic-pulse: error (${error ?? 'unknown'})`;
  return state === 'ok' || state === 'stale' ? STATE_TEXT.none : STATE_TEXT[state];
}

export function renderStatusLine(view: JsonV1, options: RenderOptions = {}): string {
  const width = widthOf(options.width);
  const [primary, ...rest] = view.epics;
  const showsEpic = view.snapshot.state === 'ok' || view.snapshot.state === 'stale';
  if (!showsEpic || !primary) return fit([stateText(view)], width);
  const line = epicLine(primary, { more: rest.length, pending: view.pending, width });
  return options.color === true ? withColor(line, primary) : line;
}
