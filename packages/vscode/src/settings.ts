import { z } from 'zod';

// `epicPulse.*` is user-edited JSON. The settings editor enforces the
// manifest's bounds, settings.json does not, so the same bounds apply here.
// The ceiling is not cosmetic: Node runs a timer longer than 2^31-1 ms after
// 1 ms instead, which would turn a typo into a refresh loop.
export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 30;
export const MAX_REFRESH_SECONDS = 86_400;

const SettingsSchema = z
  .object({
    refreshSeconds: z
      .number()
      .catch(DEFAULT_REFRESH_SECONDS)
      .transform((seconds) => Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.floor(seconds)))),
    statusBarEnabled: z.boolean().catch(true),
  })
  .readonly();

export type Settings = z.output<typeof SettingsSchema>;

export interface RawSettings {
  readonly refreshSeconds: unknown;
  readonly statusBarEnabled: unknown;
}

// Never throws: a value that is not usable falls back to its default.
export function parseSettings(raw: RawSettings): Settings {
  return SettingsSchema.parse(raw);
}
