import { resolve } from 'node:path';
import { parseRemoteUrl } from './git.js';
import { DEFAULT_HOST, parseIssueTarget, type IssueTarget } from './ref.js';
import { RepoRefSchema, type RepoRef } from './schemas/common.js';

// Where a target that names no repository of its own belongs: an explicit
// `-R` repository, or the repository of the directory the command runs in.
export type RepoHint = { readonly repo: RepoRef } | { readonly dir: string };

export type CommandSignal =
  | { readonly kind: 'bind'; readonly via: 'gh' | 'pin'; readonly target: IssueTarget; readonly hint: RepoHint }
  | { readonly kind: 'unbind'; readonly target: IssueTarget; readonly hint: RepoHint }
  | { readonly kind: 'closing'; readonly text: string; readonly hint: RepoHint };

export interface Flags {
  readonly positionals: readonly string[];
  readonly values: readonly (readonly [string, string])[];
}

// The keys are the ONLY issue verbs that bind: each changes the issue, so the
// session is working on it. `view`, `list`, `search` and `status` only read,
// and `create` has no number yet. The values are the verb's flags that take a
// value, so that value is never mistaken for a second target.
const MUTATING_ISSUE_VERBS: Readonly<Record<string, readonly string[]>> = {
  comment: ['-b', '--body', '-F', '--body-file'],
  close: ['-c', '--comment', '-r', '--reason', '--duplicate-of'],
  reopen: ['-c', '--comment'],
  edit: ['-b', '--body', '-F', '--body-file', '-t', '--title', '-m', '--milestone', '--add-assignee', '--remove-assignee',
    '--add-label', '--remove-label', '--add-project', '--remove-project'],
  develop: ['-b', '--base', '--branch-repo', '-n', '--name'],
  pin: [],
};
const REPO_FLAGS = ['-R', '--repo'];
const PR_CREATE_VALUE_FLAGS = new Set([...REPO_FLAGS, '-a', '--assignee', '-B', '--base', '-b', '--body', '-F', '--body-file',
  '-H', '--head', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '-t', '--title']);
// Shell words that can open a simple command before the program itself.
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
// `NAME=value` words before the program set its environment: `X=1 gh ...`.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GH_REPO = 'GH_REPO=';

// pflag conventions, as gh uses them: `--name=value`, `--name value`,
// `-n value` and `-nvalue`; `--` ends the flags. A flag not in `valueFlags` is
// a switch, so the word after it stays a positional.
export function parseFlags(args: readonly string[], valueFlags: ReadonlySet<string>): Flags {
  const positionals: string[] = [];
  const values: (readonly [string, string])[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (eq > 0) values.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else if (valueFlags.has(arg)) {
      values.push([arg, args[i + 1] ?? '']);
      i += 1;
    } else if (/^-[A-Za-z]./s.test(arg) && valueFlags.has(arg.slice(0, 2))) values.push([arg.slice(0, 2), arg.slice(2)]);
    else if (!arg.startsWith('-') || arg === '-') positionals.push(arg);
  }
  return { positionals, values };
}

// `-R` takes `OWNER/REPO`, `HOST/OWNER/REPO` or a URL, like gh. A bare
// OWNER/REPO means github.com, which is also what gh assumes.
export function parseRepoFlag(value: string): RepoRef | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return parseRemoteUrl(value);
  const parts = value.toLowerCase().split('/');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [host, owner, repo] = parts.length === 2 ? [DEFAULT_HOST, ...parts] : parts;
  const parsed = RepoRefSchema.safeParse({ host, owner, repo });
  return parsed.success ? parsed.data : undefined;
}

// Where a gh command without `-R` works: an inline `GH_REPO=` prefix, which gh
// reads like `-R` (an empty one counts as unset), or the directory's repository.
function envHint(prefix: readonly string[], dir: string): RepoHint | undefined {
  const value = prefix.filter((word) => word.startsWith(GH_REPO)).at(-1)?.slice(GH_REPO.length);
  if (!value) return { dir };
  const repo = parseRepoFlag(value);
  return repo ? { repo } : undefined;
}

// `-R` wins over GH_REPO, as in gh. An unreadable `-R` or GH_REPO yields no
// hint at all: falling back to the cwd would bind an issue in the wrong
// repository.
function repoHint(flags: Flags, fallback: RepoHint | undefined): RepoHint | undefined {
  const value = flags.values.filter(([flag]) => REPO_FLAGS.includes(flag)).at(-1)?.[1];
  if (value === undefined) return fallback;
  const repo = parseRepoFlag(value);
  return repo ? { repo } : undefined;
}

// gh accepts group flags (`-R`) before the verb, so the verb is the first word
// that is neither a flag nor the value of `-R`.
function splitVerb(args: readonly string[]): { readonly verb: string | undefined; readonly rest: readonly string[] } {
  for (let i = 0; i < args.length; i += 1) {
    if (REPO_FLAGS.includes(args[i]!)) i += 1;
    else if (!args[i]!.startsWith('-')) return { verb: args[i], rest: [...args.slice(0, i), ...args.slice(i + 1)] };
  }
  return { verb: undefined, rest: [] };
}

function ghIssueSignals(args: readonly string[], fallback: RepoHint | undefined): readonly CommandSignal[] {
  const { verb, rest } = splitVerb(args);
  if (verb === undefined || !Object.hasOwn(MUTATING_ISSUE_VERBS, verb)) return [];
  const flags = parseFlags(rest, new Set([...REPO_FLAGS, ...(MUTATING_ISSUE_VERBS[verb] ?? [])]));
  const hint = repoHint(flags, fallback);
  if (!hint) return [];
  return flags.positionals.flatMap((text) => {
    const target = parseIssueTarget(text);
    return target ? [{ kind: 'bind', via: 'gh', target, hint } as const] : [];
  });
}

// Only the body of `gh pr create`: GitHub reads closing keywords there, not in
// the title.
function ghPrSignals(args: readonly string[], fallback: RepoHint | undefined): readonly CommandSignal[] {
  const { verb, rest } = splitVerb(args);
  if (verb !== 'create') return [];
  const flags = parseFlags(rest, PR_CREATE_VALUE_FLAGS);
  const hint = repoHint(flags, fallback);
  const bodies = flags.values.filter(([flag]) => flag === '-b' || flag === '--body').map(([, text]) => text);
  return hint ? bodies.map((text) => ({ kind: 'closing', text, hint }) as const) : [];
}

// `-m msg`, `-mmsg`, `--message msg`, `--message=msg`, and a switch cluster
// that ends in m (`-am msg`). Git joins repeated messages as paragraphs.
function commitMessages(args: readonly string[]): readonly string[] {
  const messages: string[] = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i += 1) {
    const arg = args[i]!;
    if (arg === '--message' || /^-[A-Za-z]*m$/.test(arg)) {
      messages.push(args[i + 1] ?? '');
      i += 1;
    } else if (arg.startsWith('--message=')) messages.push(arg.slice('--message='.length));
    else if (/^-m./s.test(arg)) messages.push(arg.slice(2));
  }
  return messages;
}

// Git's own options come before the subcommand. `-C` moves the repository;
// `--git-dir` and `--work-tree` point at one the words do not reveal, so the
// command is left alone.
function gitSignals(args: readonly string[], dir: string): readonly CommandSignal[] {
  let current = dir;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-C') current = resolve(current, args[i + 1] ?? '.');
    if (arg === '-C' || arg === '-c' || arg === '--namespace') i += 1;
    else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(arg)) return [];
    else if (!arg.startsWith('-')) {
      if (arg !== 'commit') return [];
      return commitMessages(args.slice(i + 1)).map((text) => ({ kind: 'closing', text, hint: { dir: current } }) as const);
    }
  }
  return [];
}

function trackSignals(args: readonly string[], dir: string): readonly CommandSignal[] {
  const [verb, ...rest] = args;
  const word = rest.find((arg) => !arg.startsWith('-'));
  const target = word === undefined ? undefined : parseIssueTarget(word);
  if (!target) return [];
  if (verb === 'track') return [{ kind: 'bind', via: 'pin', target, hint: { dir } }];
  return verb === 'untrack' ? [{ kind: 'unbind', target, hint: { dir } }] : [];
}

function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd)$/, '');
}

export function commandSignals(words: readonly string[], dir: string): readonly CommandSignal[] {
  const start = words.findIndex((word) => !RESERVED.has(word) && !ASSIGNMENT.test(word));
  if (start === -1) return [];
  const [group, ...args] = words.slice(start + 1);
  switch (programName(words[start]!)) {
    case 'gh': {
      const hint = envHint(words.slice(0, start), dir);
      if (group === 'issue') return ghIssueSignals(args, hint);
      return group === 'pr' ? ghPrSignals(args, hint) : [];
    }
    case 'git':
      return gitSignals(words.slice(start + 1), dir);
    case 'epic-pulse':
      return trackSignals(words.slice(start + 1), dir);
    default:
      return [];
  }
}
