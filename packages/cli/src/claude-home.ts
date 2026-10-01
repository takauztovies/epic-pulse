import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StatusLineSetting } from '@epic-pulse/core';

export type SettingsScope = 'user' | 'project';

// Claude Code reads its settings from CLAUDE_CONFIG_DIR when that is set, and
// from ~/.claude otherwise. The status line runtime sits beside them at a path
// that survives plugin updates, which move the plugin's own directory.
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const override = env['CLAUDE_CONFIG_DIR']?.trim();
  return override ? resolve(override) : join(homedir(), '.claude');
}

export function runtimeFile(env: NodeJS.ProcessEnv): string {
  return join(claudeConfigDir(env), 'epic-pulse', 'runtime.mjs');
}

export function settingsFile(scope: SettingsScope, env: NodeJS.ProcessEnv, cwd: string): string {
  return scope === 'user' ? join(claudeConfigDir(env), 'settings.json') : join(cwd, '.claude', 'settings.json');
}

// A project's settings are shared through git, so they name the runtime the
// way each teammate's shell resolves it, not by one person's home directory.
// The user's own settings can name it exactly.
const SHARED_RUNTIME = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}/epic-pulse/runtime.mjs';

export function desiredStatusLine(scope: SettingsScope, env: NodeJS.ProcessEnv): StatusLineSetting {
  const runtime = scope === 'user' ? runtimeFile(env) : SHARED_RUNTIME;
  return { type: 'command', command: `node "${runtime}" statusline`, refreshInterval: 30 };
}
