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

// A project's settings are shared through git, so they can not name the runtime
// by one person's home directory: they find it the way claudeConfigDir does.
// Claude Code starts the command in whatever shell the machine has, sh, cmd or
// PowerShell, and one text has to work in all three. Each spells an environment
// variable its own way (${VAR:-x}, %VAR%, $env:VAR), so node reads it, and the
// script has none of the characters the three read specially inside double
// quotes ($ % ` \ ! and the quote itself) and no whitespace for PowerShell to
// re-quote, which is why its variables are undeclared globals, as `node -e`
// allows. An earlier revision wrote ${CLAUDE_CONFIG_DIR:-$HOME/.claude}, which
// only sh understands. The script is claudeConfigDir and runtimeFile in JS, and
// the text is a persisted format: an install is ours only while it matches.
const SHARED_SCRIPT = [
  "p=require('path')",
  'c=process.env.CLAUDE_CONFIG_DIR',
  "d=c&&c.trim()?p.resolve(c.trim()):p.join(require('os').homedir(),'.claude')",
  "f=p.join(d,'epic-pulse','runtime.mjs')",
].join(',');
const SHARED_COMMAND = `node -e "${SHARED_SCRIPT};process.argv.splice(1,0,f);import(require('url').pathToFileURL(f).href)" statusline`;

// The user's own settings can name the runtime exactly.
export function desiredStatusLine(scope: SettingsScope, env: NodeJS.ProcessEnv): StatusLineSetting {
  const command = scope === 'user' ? `node "${runtimeFile(env)}" statusline` : SHARED_COMMAND;
  return { type: 'command', command, refreshInterval: 30 };
}
