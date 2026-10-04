import { parseJson } from './result.js';
import { SettingsFileSchema, StatusLineSettingSchema } from './schemas/settings.js';

export interface StatusLineSetting {
  readonly type: 'command';
  readonly command: string;
  readonly padding?: number;
  readonly refreshInterval?: number;
}

// What the installer should do; writing the file (backup first, atomically)
// is the caller's job. `diff` shows the one line that changes, or would have.
export type MergeResult =
  | { readonly action: 'install'; readonly nextText: string; readonly diff: string }
  | { readonly action: 'noop' }
  | { readonly action: 'refuse'; readonly diff: string }
  | { readonly action: 'abort' };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffLine(sign: '-' | '+', value: unknown): string {
  return `${sign} "statusLine": ${JSON.stringify(value)}`;
}

// settings.json belongs to the user. Anything we can not parse is left alone
// (a missing file is an empty one), and a status line that is not ours is
// never replaced. The next text is built from the parsed value itself, not
// from Zod's output, because insertion order is what keeps every other key
// where the user put it; `statusLine` is appended, or replaced where a null
// one stands.
export function mergeStatusLine(existingText: string | undefined, desired: StatusLineSetting): MergeResult {
  const current = existingText === undefined ? {} : parseJson(existingText);
  if (!SettingsFileSchema.safeParse(current).success || !isRecord(current)) return { action: 'abort' };
  const existing = current['statusLine'];
  if (existing === undefined || existing === null) {
    const nextText = `${JSON.stringify({ ...current, statusLine: desired }, null, 2)}\n`;
    return { action: 'install', nextText, diff: diffLine('+', desired) };
  }
  const installed = StatusLineSettingSchema.safeParse(existing);
  if (installed.success && installed.data.command.trim() === desired.command.trim()) return { action: 'noop' };
  return { action: 'refuse', diff: `${diffLine('-', existing)}\n${diffLine('+', desired)}` };
}
