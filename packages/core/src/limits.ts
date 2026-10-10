import { z } from 'zod';

// Claude Code hands each session's status line the account's usage limits:
// `rate_limits.five_hour` and `rate_limits.seven_day`, each a used percentage and
// the time it resets (Claude Code 2.1.80 and later, for subscribers). Every
// session of an account sees the same numbers, so every status line can warn on
// its own. Read leniently: a field Claude Code drops or reshapes means no warning,
// never an error.

export const DEFAULT_WARN_AT = 90;
const MIN_WARN_AT = 50;

const WindowSchema = z
  .looseObject({
    used_percentage: z.number().min(0).max(1000),
    resets_at: z.number().nonnegative().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

export const PayloadLimitsSchema = z
  .looseObject({ five_hour: WindowSchema, seven_day: WindowSchema })
  .optional()
  .catch(undefined);

export interface LimitWindow {
  readonly pct: number;
  // Milliseconds since the epoch; null when Claude Code did not say.
  readonly resetsAt: number | null;
}

export interface LimitsReading {
  readonly v: 1;
  readonly at: number;
  readonly fiveHour: LimitWindow | null;
  readonly sevenDay: LimitWindow | null;
}

export interface LimitWarning {
  readonly window: '5h' | 'week';
  readonly pct: number;
  readonly resetsAt: number | null;
  // The step it is past (the threshold, 95, 99): an agent is told once per step.
  readonly band: number;
}

function windowOf(raw: z.infer<typeof WindowSchema>): LimitWindow | null {
  if (raw === undefined) return null;
  const seconds = raw.resets_at;
  return { pct: Math.min(100, raw.used_percentage), resetsAt: seconds === undefined ? null : Math.round(seconds * 1000) };
}

// Undefined when the payload carries no limits (an API key, an older Claude Code).
export function readingFrom(raw: unknown, now: number): LimitsReading | undefined {
  const parsed = PayloadLimitsSchema.parse(raw);
  const fiveHour = windowOf(parsed?.five_hour);
  const sevenDay = windowOf(parsed?.seven_day);
  return fiveHour === null && sevenDay === null ? undefined : { v: 1, at: now, fiveHour, sevenDay };
}

// EPIC_PULSE_LIMIT_WARN, a whole percentage from 50 to 100; anything else is 90.
export function warnAt(env: NodeJS.ProcessEnv): number {
  const value = Number(env['EPIC_PULSE_LIMIT_WARN']);
  return Number.isInteger(value) && value >= MIN_WARN_AT && value <= 100 ? value : DEFAULT_WARN_AT;
}

function bandOf(pct: number, threshold: number): number {
  return [99, 95, threshold].filter((step) => step >= threshold).sort((a, b) => b - a).find((step) => pct >= step) ?? threshold;
}

// The fuller of the two windows that is past the threshold and has not reset yet.
export function limitWarning(reading: LimitsReading, threshold: number, now: number): LimitWarning | undefined {
  const windows = [['5h', reading.fiveHour], ['week', reading.sevenDay]] as const;
  const open = windows.flatMap(([window, value]) => (value && (value.resetsAt === null || value.resetsAt > now) && value.pct >= threshold ? [{ window, ...value }] : []));
  const worst = open.sort((a, b) => b.pct - a.pct)[0];
  return worst && { window: worst.window, pct: Math.floor(worst.pct), resetsAt: worst.resetsAt, band: bandOf(worst.pct, threshold) };
}

// "resets in 2h10m", "resets in 35 min"; nothing when the time is not known.
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '';
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `resets in ${hours}h${String(minutes % 60).padStart(2, '0')}m` : `resets in ${Math.floor(hours / 24)} days`;
}

// What the status line puts in front of the epic, longest first.
export function warningVariants(warning: LimitWarning, now: number): readonly string[] {
  const label = warning.window === '5h' ? '5h limit' : 'weekly limit';
  const resets = resetText(warning.resetsAt, now);
  return [
    `⚠ ${warning.pct}% ${label}${resets ? `, ${resets}` : ''} · /compact`,
    `⚠ ${warning.pct}% ${label} · /compact`,
    `⚠ ${warning.pct}%`,
  ];
}

// What a session's agent is told, once per step. Plain words: it is read by the
// model, and by the user in the transcript.
export function agentNote(warning: LimitWarning, now: number): string {
  const label = warning.window === '5h' ? 'the 5-hour usage limit' : 'the weekly usage limit';
  const resets = resetText(warning.resetsAt, now);
  return [
    `epic-pulse: this Claude account is at ${warning.pct}% of ${label}${resets ? ` (${resets})` : ''}, shared by every session.`,
    'Wrap up: finish the step you are on, write a short handoff of where things stand,',
    'and do not start new subagents, workflows or long-running work.',
    `Tell the user it is at ${warning.pct}% and suggest /compact when this step is done.`,
  ].join(' ');
}
