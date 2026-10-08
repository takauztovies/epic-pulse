import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findWorktree } from './git.js';
import { compileBranchPattern, DEFAULT_BRANCH_PATTERN } from './branch-pattern.js';
import { parseJira, type JiraConfig } from './jira-config.js';
import { DEFAULT_PROGRESS, parseProgress, type ProgressConfig } from './progress-config.js';
import { parseJson } from './result.js';
import { CONFIG_LIMITS, RawConfigSchema } from './schemas/config.js';

export const CONFIG_FILE = '.epic-pulse.json';

export interface Config {
  readonly branchIssuePattern: RegExp;
  readonly ignorePaths: readonly string[];
  readonly ignoreMainCheckout: boolean;
  readonly progress: ProgressConfig;
  // Absent unless the repository declares a Jira site and projects.
  readonly jira?: JiraConfig;
}

export const DEFAULT_CONFIG: Config = {
  branchIssuePattern: DEFAULT_BRANCH_PATTERN,
  ignorePaths: [],
  ignoreMainCheckout: false,
  progress: DEFAULT_PROGRESS,
};

// `docs/`, `./docs` and `docs\` all mean the docs directory. An absolute entry
// or one with `..` can never name a path inside the worktree, so it is dropped
// rather than guessed at.
export function normaliseIgnorePath(entry: unknown): string | undefined {
  if (typeof entry !== 'string' || entry.length > CONFIG_LIMITS.maxIgnorePathLength) return undefined;
  const slashed = entry.replace(/\\/g, '/');
  const parts = slashed.split('/').filter((part) => part !== '' && part !== '.');
  const absolute = slashed.startsWith('/') || /^[a-z]:/i.test(slashed);
  return absolute || parts.length === 0 || parts.includes('..') ? undefined : parts.join('/');
}

function ignorePathsOf(entries: readonly unknown[] | undefined): readonly string[] {
  const normalised = (entries ?? []).flatMap((entry) => normaliseIgnorePath(entry) ?? []);
  return [...new Set(normalised)].slice(0, CONFIG_LIMITS.maxIgnorePaths);
}

// Each field is checked on its own: a bad pattern falls back to the default
// pattern without discarding a valid `ignorePaths` next to it.
export function parseConfig(value: unknown): Config {
  const raw = RawConfigSchema.safeParse(value);
  if (!raw.success) return DEFAULT_CONFIG;
  const jira = parseJira(raw.data.jira);
  const source = raw.data.branchIssuePattern;
  const compiled = source === undefined ? undefined : compileBranchPattern(source);
  return {
    branchIssuePattern: compiled?.ok ? compiled.value : DEFAULT_BRANCH_PATTERN,
    ignorePaths: ignorePathsOf(raw.data.ignorePaths),
    ignoreMainCheckout: raw.data.ignoreMainCheckout ?? false,
    progress: parseProgress(raw.data.progress),
    ...(jira ? { jira } : {}),
  };
}

// The repository's own `.epic-pulse.json`, found from any directory inside it.
export async function loadProgressFor(dir: string): Promise<ProgressConfig> {
  const worktree = await findWorktree(dir);
  return worktree ? (await loadConfig(worktree.root)).progress : DEFAULT_PROGRESS;
}

export async function loadConfig(root: string): Promise<Config> {
  const file = join(root, CONFIG_FILE);
  try {
    if ((await stat(file)).size > CONFIG_LIMITS.maxFileBytes) return DEFAULT_CONFIG;
    return parseConfig(parseJson(await readFile(file, 'utf8')));
  } catch {
    return DEFAULT_CONFIG; // missing or unreadable: nothing is configured
  }
}

// Prefixes match whole segments: `docs` covers `docs/a.md`, not `docs-site/a.md`.
export function isIgnoredPath(config: Config, root: string, path: string): boolean {
  const inside = relative(root, path).replace(/\\/g, '/');
  return config.ignorePaths.some((prefix) => inside === prefix || inside.startsWith(`${prefix}/`));
}
