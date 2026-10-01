import { readFile, writeFile } from 'node:fs/promises';
import { atomicWriteFile, errnoOf, fail, mergeStatusLine, ok, type MergeResult, type Result } from '@epic-pulse/core';
import { parseCommandArgs } from './args.js';
import { desiredStatusLine, runtimeFile, settingsFile, type SettingsScope } from './claude-home.js';
import { failWith, printError, printLine, usageError } from './io.js';
import { syncRuntime } from './runtime.js';

type InstallResult = Extract<MergeResult, { readonly action: 'install' }>;

interface Plan {
  readonly file: string;
  readonly original: Buffer | undefined;
  readonly result: MergeResult;
  readonly dryRun: boolean;
  readonly env: NodeJS.ProcessEnv;
}

async function readSettings(file: string): Promise<Result<Buffer | undefined, 'io'>> {
  try {
    return ok(await readFile(file));
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? ok(undefined) : fail('io');
  }
}

// Named after the file and the moment, created exclusively and private to the
// owner: a settings file can carry tokens in its `env` block.
async function backup(file: string, original: Buffer, now: number): Promise<string> {
  const path = `${file}.epic-pulse-${new Date(now).toISOString().replace(/[:.]/g, '-')}.bak`;
  await writeFile(path, original, { flag: 'wx', mode: 0o600 });
  return path;
}

// Somebody else's status line stays. Chaining the two is planned; replacing
// one silently never is.
function refuse(plan: Plan, diff: string): number {
  printError(`epic-pulse: ${plan.file} already has a statusLine that is not epic-pulse's, so it was left unchanged.`);
  printError(diff);
  printError('epic-pulse: to switch, remove that statusLine and run this again.');
  return 1;
}

function preview(plan: Plan): number {
  printLine('epic-pulse: dry run, nothing was written.');
  if (plan.result.action !== 'install') {
    printLine(`epic-pulse: the status line is already installed in ${plan.file}.`);
    return 0;
  }
  printLine(`epic-pulse: would change ${plan.file}:`);
  printLine(plan.result.diff);
  if (plan.original !== undefined) printLine('epic-pulse: would save a timestamped backup of it first.');
  printLine(`epic-pulse: would copy the runtime to ${runtimeFile(plan.env)}.`);
  return 0;
}

// Already installed: only the runtime copy may be behind, after an upgrade.
async function keep(plan: Plan): Promise<number> {
  const synced = await syncRuntime(plan.env);
  if (!synced.ok) return failWith(`the runtime could not be copied to ${runtimeFile(plan.env)}`);
  printLine(`epic-pulse: the status line is already installed in ${plan.file}; nothing to change.`);
  if (synced.value === 'copied') printLine(`epic-pulse: updated the runtime at ${runtimeFile(plan.env)}.`);
  return 0;
}

// The runtime first, so the settings never name a file that is not there; then
// the backup; then the settings, atomically.
async function install(plan: Plan, result: InstallResult): Promise<number> {
  const synced = await syncRuntime(plan.env);
  if (!synced.ok) return failWith(`the runtime could not be copied to ${runtimeFile(plan.env)}, so the settings were left unchanged`);
  const saved = plan.original === undefined ? undefined : await backup(plan.file, plan.original, Date.now());
  await atomicWriteFile(plan.file, result.nextText);
  printLine(`epic-pulse: installed the status line in ${plan.file}:`);
  printLine(result.diff);
  if (saved !== undefined) printLine(`epic-pulse: the previous file is saved as ${saved}.`);
  printLine(`epic-pulse: runtime: ${runtimeFile(plan.env)}`);
  return 0;
}

async function apply(plan: Plan): Promise<number> {
  const { result } = plan;
  if (result.action === 'abort') return failWith(`${plan.file} is not a JSON object, so it was left unchanged.`);
  if (result.action === 'refuse') return refuse(plan, result.diff);
  if (plan.dryRun) return preview(plan);
  return result.action === 'noop' ? keep(plan) : install(plan, result);
}

export async function runInstall(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { booleans: ['dry-run', 'project'] });
  if (!parsed) return usageError('statusline install [--dry-run] [--project]');
  const scope: SettingsScope = parsed.flags.has('project') ? 'project' : 'user';
  const file = settingsFile(scope, env, process.cwd());
  const read = await readSettings(file);
  if (!read.ok) return failWith(`${file} can not be read, so it was left unchanged`);
  const result = mergeStatusLine(read.value?.toString('utf8'), desiredStatusLine(scope, env));
  return apply({ file, original: read.value, result, dryRun: parsed.flags.has('dry-run'), env });
}
