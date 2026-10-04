import { z } from 'zod';

// Claude Code's settings.json, only as far as the status line installer reads
// it: an object whose `statusLine`, if any, may already be ours. Every other
// key passes through unread.
export const SettingsFileSchema = z.looseObject({ statusLine: z.unknown().optional() });

// Enough of an existing statusLine to tell whether it runs our command.
export const StatusLineSettingSchema = z.looseObject({ type: z.string().optional(), command: z.string() });

export type SettingsFile = z.infer<typeof SettingsFileSchema>;
export type StatusLineSettingShape = z.infer<typeof StatusLineSettingSchema>;
