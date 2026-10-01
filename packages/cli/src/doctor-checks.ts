import { readFile } from 'node:fs/promises';
import {
  DEFAULT_HOST, errnoOf, findWorktree, LIVE_WINDOW_MS, mergeStatusLine, pathsFor, readRemote, registryDirFor, repoKey, resolveToken,
  type MergeResult, type RepoRef,
} from '@epic-pulse/core';
import { lastHookActivity } from './activity.js';
import { desiredStatusLine, runtimeFile, settingsFile, type SettingsScope } from './claude-home.js';
import { lastHookError } from './hook-log.js';
import { runtimeState, type RuntimeState } from './runtime.js';

export type Check = readonly [label: string, value: string];

const MIN_NODE_MAJOR = 22;

const STATUS_LINE_STATES: Readonly<Record<MergeResult['action'], string>> = {
  install: 'not installed',
  noop: 'installed',
  refuse: "another statusLine is set, so epic-pulse's is not",
  abort: 'the file is not a JSON object',
};

const RUNTIME_STATES: Readonly<Record<RuntimeState, string>> = {
  missing: 'missing: run `epic-pulse statusline install`, or start a session with the plugin enabled',
  current: 'present, the same build as this one',
  outdated: 'present, a different build from this one',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nodeCheck(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return ['node', major >= MIN_NODE_MAJOR ? process.version : `${process.version}, but epic-pulse needs ${MIN_NODE_MAJOR} or newer`];
}

export async function repoChecks(cwd: string): Promise<{ readonly checks: readonly Check[]; readonly remote: RepoRef | undefined }> {
  const worktree = await findWorktree(cwd);
  if (!worktree) return { checks: [['repository', 'not inside a git repository']], remote: undefined };
  const remote = await readRemote(worktree.commonDir);
  const kind = worktree.isMain ? 'main checkout' : 'linked worktree';
  return {
    checks: [['repository', `${worktree.root} (${kind})`], ['remote', remote ? repoKey(remote) : 'none, and epic-pulse needs a GitHub remote']],
    remote,
  };
}

// The source's name only. The token itself stays in memory and is dropped.
// Another host takes an Enterprise variable only once the user names it.
export async function tokenCheck(host: string, env: NodeJS.ProcessEnv): Promise<Check> {
  const found = await resolveToken(host, env);
  if (found) return ['token', `from ${found.source}`];
  if (host === DEFAULT_HOST) return ['token', `none for ${host}: set GH_TOKEN or run \`gh auth login\``];
  return ['token', `none for ${host}: run \`gh auth login --hostname ${host}\`, or set GH_ENTERPRISE_TOKEN and name the host in GH_HOST or EPIC_PULSE_HOSTS`];
}

function hookState(last: number | undefined, now: number): string {
  if (last === undefined) return 'inactive: no hook has written here. Is the epic-pulse plugin enabled, and is Node on the PATH?';
  return now - last > LIVE_WINDOW_MS ? `inactive: last ran ${iso(last)}` : `active: last ran ${iso(last)}`;
}

export async function registryChecks(cwd: string, env: NodeJS.ProcessEnv, now: number): Promise<readonly Check[]> {
  const dir = await registryDirFor(cwd, env);
  if (dir === undefined) return [['registry', 'none outside a git repository']];
  const [last, error] = await Promise.all([lastHookActivity(pathsFor(dir)), lastHookError(dir)]);
  return [
    ['registry', dir],
    ['hook', hookState(last, now)],
    ['hook errors', error ? `last: ${error.code} at ${iso(error.ts)}` : 'none'],
  ];
}

export async function statusLineCheck(scope: SettingsScope, env: NodeJS.ProcessEnv, cwd: string): Promise<Check> {
  const file = settingsFile(scope, env, cwd);
  const text = await readFile(file, 'utf8').catch((error: unknown) => (errnoOf(error) === 'ENOENT' ? undefined : null));
  const state = text === null ? 'the file can not be read' : STATUS_LINE_STATES[mergeStatusLine(text, desiredStatusLine(scope, env)).action];
  return [`statusLine (${scope})`, `${state}: ${file}`];
}

export async function runtimeCheck(env: NodeJS.ProcessEnv): Promise<Check> {
  return ['runtime', `${RUNTIME_STATES[await runtimeState(env)]}: ${runtimeFile(env)}`];
}
