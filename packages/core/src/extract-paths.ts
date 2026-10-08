import { isAbsolute } from 'node:path';
import { branchIssueNumber } from './branch-pattern.js';
import { jiraKeysIn } from './jira-keys.js';
import { isIgnoredPath, loadConfig, type Config } from './config.js';
import { findWorktree, readBranch, readRemote, type WorktreeInfo } from './git.js';
import { makeRef } from './ref.js';
import type { IssueRef, RepoRef } from './schemas/common.js';

export interface WorktreeContext {
  readonly info: WorktreeInfo;
  readonly config: Config;
  readonly branch: string | undefined;
  readonly remote: RepoRef | undefined;
}

async function contextFor(info: WorktreeInfo): Promise<WorktreeContext> {
  const [config, branch, remote] = await Promise.all([loadConfig(info.root), readBranch(info), readRemote(info.commonDir)]);
  return { info, config, branch, remote };
}

// File reads only, one lookup per distinct path and one set of reads per
// distinct worktree, all in parallel. Keyed by the path that was asked for.
export async function worktreeContexts(paths: readonly string[]): Promise<ReadonlyMap<string, WorktreeContext>> {
  const unique = [...new Set(paths)];
  const infos = await Promise.all(unique.map((path) => findWorktree(path)));
  const byRoot = new Map(infos.flatMap((info) => (info ? [[info.root, info] as const] : [])));
  const contexts = new Map(await Promise.all([...byRoot.values()].map(async (info) => [info.root, await contextFor(info)] as const)));
  return new Map(
    unique.flatMap((path, i) => {
      const context = contexts.get(infos[i]?.root ?? '');
      return context ? [[path, context] as const] : [];
    }),
  );
}

// The issue a path belongs to through its worktree's branch name, unless the
// worktree's config excludes the path or the checkout.
export function branchRef(path: string, context: WorktreeContext): IssueRef | undefined {
  const { info, config, branch, remote } = context;
  if (config.ignoreMainCheckout && info.isMain) return undefined;
  if (isIgnoredPath(config, info.root, path)) return undefined;
  const key = branch === undefined || !config.jira ? undefined : jiraKeysIn(branch, config.jira)[0];
  if (key) return key;
  const number = branch === undefined ? undefined : branchIssueNumber(branch, config.branchIssuePattern);
  return number !== undefined && remote ? makeRef({ ...remote, number }) : undefined;
}

// Words that are absolute paths, including the value of `--option=/path`.
export function absolutePaths(words: readonly string[]): readonly string[] {
  return words.flatMap((word) => {
    const value = /^--[\w-]+=(.+)$/s.exec(word)?.[1] ?? word;
    return isAbsolute(value) ? [value] : [];
  });
}
