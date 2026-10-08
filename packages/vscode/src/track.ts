import {
  addPin, DEFAULT_HOST, findWorktree, loadConfig, makeJiraRef, makeRef, parseIssueTarget, pathsFor, qualifiedKey, readRemote, removePin,
  type IssueRef, type PinsErrorCode,
} from '@epic-pulse/core';
import type { RepoTarget } from './repos.js';

export interface TrackResult {
  readonly ok: boolean;
  readonly message: string;
}

const PIN_ERROR_TEXT: Readonly<Record<PinsErrorCode, string>> = {
  corrupt: 'epic-pulse: pins.json can not be read, so it was left unchanged.',
  full: 'epic-pulse: this repository already has the maximum of 200 pins.',
  io: 'epic-pulse: pins.json could not be written.',
};

// A target that names no repository belongs to the one the folder is in; a
// bare owner/repo means that repository's host, or github.com. Mirrors the
// CLI's own `track`/`untrack` resolution (packages/cli/src/track.ts).
async function refFor(text: string, folder: string): Promise<IssueRef | undefined> {
  const target = parseIssueTarget(text);
  if (!target) return undefined;
  const worktree = await findWorktree(folder);
  if (target.jira) {
    // A bare key belongs to the site the repository declares; a URL names its own.
    const host = target.jira.host ?? (worktree ? (await loadConfig(worktree.root)).jira?.site : undefined);
    return host ? makeJiraRef({ host, project: target.jira.project, number: target.number }) : undefined;
  }
  const base = worktree ? await readRemote(worktree.commonDir) : undefined;
  const own = target.repo;
  const repo = own ? { host: own.host ?? base?.host ?? DEFAULT_HOST, owner: own.owner, repo: own.repo } : base;
  return repo ? makeRef({ ...repo, number: target.number }) : undefined;
}

const NOT_FOUND = 'epic-pulse: that is not a number, owner/repo#N, or issue URL, and this repository has no GitHub remote to default to.';

// Pins the issue to this repository's pins.json, persistently: it shows in the
// tree whether or not a live session is working on it, until untracked.
export async function trackIn(repo: RepoTarget, text: string, now: number): Promise<TrackResult> {
  const ref = await refFor(text, repo.folder);
  if (!ref) return { ok: false, message: NOT_FOUND };
  const result = await addPin(pathsFor(repo.dir), ref, now);
  if (!result.ok) return { ok: false, message: PIN_ERROR_TEXT[result.error] };
  const key = qualifiedKey(ref);
  return { ok: true, message: result.value.changed ? `epic-pulse: pinned ${key}.` : `epic-pulse: ${key} was already pinned.` };
}

// An epic shown in the tree names its own URL but not which repository's
// pins.json holds it (a multi-root window may fold copies from more than
// one), so this removes the pin from every repository that has it: a repo
// that never pinned it is an unchanged no-op, per core's removePin.
export async function untrackEverywhere(repos: readonly RepoTarget[], epicUrl: string): Promise<TrackResult> {
  const target = parseIssueTarget(epicUrl);
  const jiraRef = target?.jira?.host ? makeJiraRef({ host: target.jira.host, project: target.jira.project, number: target.number }) : undefined;
  const ref = jiraRef ?? (target?.repo && makeRef({ host: target.repo.host ?? DEFAULT_HOST, owner: target.repo.owner, repo: target.repo.repo, number: target.number }));
  if (!ref) return { ok: false, message: NOT_FOUND };
  const results = await Promise.all(repos.map((repo) => removePin(pathsFor(repo.dir), ref)));
  const failed = results.find((result) => !result.ok);
  if (failed && !failed.ok) return { ok: false, message: PIN_ERROR_TEXT[failed.error] };
  const key = qualifiedKey(ref);
  const changed = results.some((result) => result.ok && result.value.changed);
  return { ok: true, message: changed ? `epic-pulse: unpinned ${key}.` : `epic-pulse: ${key} was not pinned.` };
}
