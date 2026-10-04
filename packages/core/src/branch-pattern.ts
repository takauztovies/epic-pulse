import { fail, ok, type Result } from './result.js';
import { CONFIG_LIMITS } from './schemas/config.js';

// The number that opens a branch name, behind at most one prefix segment:
// `123-login`, `fix/123-login`, `feat/#77`, `42`. Only `-`, `_` or the end may
// follow it. An earlier version also took `.` and `/`, which read
// `release/1.2.3` as issue #1 and `hotfix/2.0` as #2.
export const DEFAULT_BRANCH_PATTERN = /^(?:[\w.-]+\/)?#?(\d+)(?:[-_]|$)/;

// Git allows longer names, but no branch that names an issue needs one, and the
// cap bounds the work a user pattern can do on each hook call.
const MAX_BRANCH_LENGTH = 255;

export type PatternRejection = 'too_long' | 'invalid' | 'capture_groups' | 'backtracking';

type Token = 'open' | 'close' | 'alt' | 'repeat' | 'once' | 'atom';

// `*`, `+`, `{2}`, `{2,}` and `{2,5}` repeat; `?`, `{1}` and `{0,1}` do not.
function quantifierAt(source: string, i: number): { readonly length: number; readonly repeats: boolean } | undefined {
  const char = source[i];
  if (char === '*' || char === '+') return { length: 1, repeats: true };
  if (char === '?') return { length: 1, repeats: false };
  const braces = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i, i + 24));
  if (!braces) return undefined;
  const max = braces[2] === undefined ? Number(braces[1]) : braces[2] === '' ? Infinity : Number(braces[2]);
  return { length: braces[0].length, repeats: max > 1 };
}

// Index just past the `]` closing the class opened at `i`. Without the `v`
// flag the first unescaped `]` closes it, even right after `[`.
function classEnd(source: string, i: number): number {
  for (let j = i + 1; j < source.length; j += 1) {
    if (source[j] === '\\') j += 1;
    else if (source[j] === ']') return j + 1;
  }
  return source.length;
}

// `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or `(?<name>`: the `?` is syntax, not a quantifier.
function groupOpenLength(source: string, i: number): number {
  if (source[i + 1] !== '?') return 1;
  const named = /^\(\?<(?![=!])[^>]*>/.exec(source.slice(i, i + CONFIG_LIMITS.maxPatternLength));
  if (named) return named[0].length;
  return source[i + 2] === '<' ? 4 : 3;
}

function tokenAt(source: string, i: number): readonly [Token, number] {
  const quantifier = quantifierAt(source, i);
  if (quantifier) return [quantifier.repeats ? 'repeat' : 'once', quantifier.length];
  switch (source[i]) {
    case '\\': return ['atom', 2];
    case '[': return ['atom', classEnd(source, i) - i];
    case '(': return ['open', groupOpenLength(source, i)];
    case ')': return ['close', 1];
    case '|': return ['alt', 1];
    default: return ['atom', 1];
  }
}

function tokens(source: string): readonly Token[] {
  const out: Token[] = [];
  for (let i = 0; i < source.length; ) {
    const [token, length] = tokenAt(source, i);
    out.push(token);
    i += length;
  }
  return out;
}

// Refuses the shapes that backtrack exponentially: a group that holds a
// repetition or an alternation and is itself repeated, like `(a+)+` or
// `(a|ab)*`. Over-strict on purpose: a refused pattern only means the default
// is used, while an accepted bad one would stall every hook call in the repo.
export function isBacktrackSafe(source: string): boolean {
  const open: boolean[] = []; // per open group: does it hold a repetition or `|`?
  let previousRisky = false; // the atom before this token is a risky group
  for (const token of tokens(source)) {
    if (token === 'repeat' && previousRisky) return false;
    if ((token === 'repeat' || token === 'alt') && open.length > 0) open[open.length - 1] = true;
    if (token === 'open') open.push(false);
    const closedRisky = token === 'close' && open.pop() === true;
    if (closedRisky && open.length > 0) open[open.length - 1] = true;
    previousRisky = closedRisky;
  }
  return true;
}

// An alternative that matches the empty string always matches, and the match
// array has one slot per capture group, so this counts groups without a parser.
function captureGroups(source: string): number {
  return (new RegExp(`${source}|`).exec('') ?? []).length - 1;
}

// The pattern comes from `.epic-pulse.json`, i.e. from whatever repository is
// open. It is compiled without flags, so no `g`/`y` state survives between
// calls, and it must have exactly one group: the issue number.
export function compileBranchPattern(source: string): Result<RegExp, PatternRejection> {
  if (source.length > CONFIG_LIMITS.maxPatternLength) return fail('too_long');
  let pattern: RegExp;
  try {
    pattern = new RegExp(source);
  } catch {
    return fail('invalid');
  }
  if (captureGroups(source) !== 1) return fail('capture_groups');
  return isBacktrackSafe(source) ? ok(pattern) : fail('backtracking');
}

export function branchIssueNumber(branch: string, pattern: RegExp): number | undefined {
  if (branch.length > MAX_BRANCH_LENGTH) return undefined;
  const captured = pattern.exec(branch)?.[1];
  return captured !== undefined && /^\d{1,10}$/.test(captured) ? Number(captured) : undefined;
}
