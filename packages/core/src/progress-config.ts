// What the percentages and the bar count for, from the `progress` block of
// `.epic-pulse.json`. All whole numbers, so the arithmetic is exact: a weight is
// a percentage of an item, a size is a number of points.
export interface ProgressConfig {
  readonly inProgress: number;
  readonly inReview: number;
  readonly sizes: Readonly<Record<string, number>>;
  readonly unsized: number;
}

export const PROGRESS_LIMITS = { maxSizes: 30, maxLabelLength: 60, maxPoints: 1000 } as const;

const DEFAULT_SIZES: Readonly<Record<string, number>> = { 'size/xs': 1, 'size/s': 2, 'size/m': 3, 'size/l': 5, 'size/xl': 8 };

// The lower median: with the default table that is medium.
function medianOf(sizes: Readonly<Record<string, number>>): number {
  const sorted = Object.values(sizes).sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 1;
}

export const DEFAULT_PROGRESS: ProgressConfig = { inProgress: 25, inReview: 75, sizes: DEFAULT_SIZES, unsized: medianOf(DEFAULT_SIZES) };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

// Below 100: a bar that fills before the work is done would lie.
function weightsOf(raw: Record<string, unknown>): Pick<ProgressConfig, 'inProgress' | 'inReview'> {
  const inProgress = integerIn(raw['inProgress'], 0, 99) ?? DEFAULT_PROGRESS.inProgress;
  const inReview = integerIn(raw['inReview'], 0, 99) ?? DEFAULT_PROGRESS.inReview;
  return inProgress <= inReview ? { inProgress, inReview } : { inProgress: DEFAULT_PROGRESS.inProgress, inReview: DEFAULT_PROGRESS.inReview };
}

// A table replaces the default as a whole; entries that are not a name and a
// positive whole number of points are dropped, and none left keeps the default.
function sizesOf(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return DEFAULT_SIZES;
  const entries = Object.entries(value).flatMap(([name, points]) => {
    const key = name.trim().toLowerCase();
    const worth = integerIn(points, 1, PROGRESS_LIMITS.maxPoints);
    return key.length > 0 && key.length <= PROGRESS_LIMITS.maxLabelLength && worth !== undefined ? [[key, worth] as const] : [];
  });
  return entries.length === 0 ? DEFAULT_SIZES : Object.fromEntries(entries.slice(0, PROGRESS_LIMITS.maxSizes));
}

export function parseProgress(value: unknown): ProgressConfig {
  if (!isRecord(value)) return DEFAULT_PROGRESS;
  const sizes = sizesOf(value['sizes']);
  return { ...weightsOf(value), sizes, unsized: integerIn(value['unsized'], 1, PROGRESS_LIMITS.maxPoints) ?? medianOf(sizes) };
}
