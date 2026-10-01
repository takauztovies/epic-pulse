import {
  addPin, DEFAULT_HOST, findWorktree, LIVE_WINDOW_MS, makeRef, parseIssueTarget, pathsFor, readRemote, refKey,
  registryDirFor, removePin, type IssueRef, type IssueTarget, type PinsErrorCode,
} from '@epic-pulse/core';
import { lastHookActivity } from './activity.js';
import { parseCommandArgs } from './args.js';
import { failWith, NOT_A_REPO, printError, printLine, usageError } from './io.js';

export type TrackVerb = 'track' | 'untrack';

const PIN_ERRORS: Readonly<Record<PinsErrorCode, string>> = {
  corrupt: 'pins.json can not be read, so it was left unchanged',
  full: 'this repository already has the maximum of 200 pins',
  io: 'pins.json could not be written',
};

// A target that names no repository belongs to the one this directory is in,
// and a bare owner/repo means that repository's host, or github.com.
async function refFor(target: IssueTarget, cwd: string): Promise<IssueRef | undefined> {
  const worktree = await findWorktree(cwd);
  const base = worktree ? await readRemote(worktree.commonDir) : undefined;
  const own = target.repo;
  const repo = own ? { host: own.host ?? base?.host ?? DEFAULT_HOST, owner: own.owner, repo: own.repo } : base;
  return repo ? makeRef({ ...repo, number: target.number }) : undefined;
}

// Inside Claude Code the PostToolUse hook reads this very command line and pins
// the issue to the session that ran it, and to no other. A repository pin
// written here would show in every session, so nothing is written.
async function sessionOnly(verb: TrackVerb, word: string, env: NodeJS.ProcessEnv): Promise<number> {
  printLine(verb === 'track' ? `epic-pulse: the hook pins ${word} to this session.` : `epic-pulse: the hook unpins ${word} from this session.`);
  printLine('epic-pulse: nothing was written. Add --repo to change the pin for the whole repository.');
  const dir = await registryDirFor(process.cwd(), env);
  const last = dir === undefined ? undefined : await lastHookActivity(pathsFor(dir));
  if (last === undefined || Date.now() - last > LIVE_WINDOW_MS) {
    printError('epic-pulse: no epic-pulse hook has run here in the last 2 hours, so nothing may pick this up. Is the plugin enabled?');
  }
  return 0;
}

function changed(verb: TrackVerb, ref: IssueRef, didChange: boolean): string {
  const key = refKey(ref);
  if (verb === 'track') return didChange ? `epic-pulse: pinned ${key} for this repository.` : `epic-pulse: ${key} was already pinned.`;
  return didChange ? `epic-pulse: unpinned ${key}.` : `epic-pulse: ${key} was not pinned.`;
}

async function repoPin(verb: TrackVerb, target: IssueTarget, env: NodeJS.ProcessEnv): Promise<number> {
  const cwd = process.cwd();
  const dir = await registryDirFor(cwd, env);
  if (dir === undefined) return failWith(NOT_A_REPO);
  const ref = await refFor(target, cwd);
  if (!ref) return failWith('this repository has no GitHub remote; name one as owner/repo#N');
  const paths = pathsFor(dir);
  const result = verb === 'track' ? await addPin(paths, ref, Date.now()) : await removePin(paths, ref);
  if (!result.ok) return failWith(PIN_ERRORS[result.error]);
  printLine(changed(verb, ref, result.value.changed));
  return 0;
}

export async function runTrack(verb: TrackVerb, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { booleans: ['repo'], positionals: 1 });
  const word = parsed?.positionals[0];
  const target = word === undefined ? undefined : parseIssueTarget(word);
  if (!parsed || word === undefined || !target) return usageError(`${verb} <number | owner/repo#N | issue URL> [--repo]`);
  const insideClaude = env['CLAUDECODE'] === '1';
  return insideClaude && !parsed.flags.has('repo') ? sessionOnly(verb, word, env) : repoPin(verb, target, env);
}
