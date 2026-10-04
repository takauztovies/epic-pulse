import type { JsonEpic, JsonV1 } from './schemas/json-v1.js';

// One line for Claude Code's status line, from a view that is already scoped
// to the session: its first epic in full, the rest as a count.
//   #1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)

export interface RenderOptions {
  readonly width?: number;
}

const BAR_CELLS = 10;
const DEFAULT_WIDTH = 80;

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

// Floored like the percent, so a full bar only ever means a finished epic.
function bar(percent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.floor((percent * BAR_CELLS) / 100)));
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`;
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
  const head = `#${epic.number} ${epic.percent}% ${fraction(epic)}`;
  const withBar = `#${epic.number} ${bar(epic.percent)} ${epic.percent}% ${fraction(epic)}`;
  return fit([
    [withBar, ...detail, ...stale, ...loading].join(' · ') + extra,
    [head, ...detail, ...stale, ...loading].join(' · ') + extra,
    [head, ...stale, ...loading].join(' · ') + extra,
    [`#${epic.number} ${epic.percent}%`, ...stale].join(' · '),
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
  return showsEpic && primary ? epicLine(primary, { more: rest.length, pending: view.pending, width }) : fit([stateText(view)], width);
}
