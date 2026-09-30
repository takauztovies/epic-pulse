import { heredocAt, readWord, skipHeredocs, type Heredoc } from './shell-words.js';

// A small, deliberately partial reading of POSIX shell: enough to recover the
// argv words, command boundaries, redirection targets and heredoc bodies of
// the commands an agent writes. Nothing is expanded or executed. Anything it
// does not understand stays inside a word, which at worst hides a signal; it
// never turns quoted text or a heredoc body into a command.

export interface SimpleCommand {
  readonly words: readonly string[];
  // `> file` targets are paths the command touches, never arguments, so a
  // trailing `2>&1` can not become an issue number.
  readonly targets: readonly string[];
  // An unquoted `*`, `?` or `[...]` in this command: it works on a set of
  // files, so its paths say nothing about one issue. Set by parseShell.
  readonly glob?: boolean;
}

export interface ParsedShell {
  readonly commands: readonly SimpleCommand[];
  // Whether any of the commands has a glob.
  readonly glob: boolean;
}

type Token =
  | { readonly kind: 'word'; readonly text: string; readonly glob: boolean }
  | { readonly kind: 'redirect'; readonly takesTarget: boolean }
  | { readonly kind: 'break' };

interface Lexed {
  readonly token?: Token;
  readonly end: number;
  readonly pending: readonly Heredoc[];
}

const MAX_COMMAND_LENGTH = 256 * 1024;
const BREAK: Token = { kind: 'break' };
const OPERATORS = ['&&', '||', '|&', ';', '|', '&', '(', ')'] as const;
// Longest first. `<<` and `<<-` are heredocs and handled before these.
const REDIRECTS = ['&>>', '&>', '<<<', '>>', '>|', '>&', '<&', '<>', '>', '<'] as const;
const GLOB = /[*?]|\[[^\]]*\]/;
// `>&2`, `<&0` and `>&-` duplicate or close a descriptor: there is no target.
const DESCRIPTOR = /^(?:\d+|-)(?=[\s;&|()<>]|$)/;

function redirection(src: string, i: number, op: string): Lexed {
  const after = i + op.length;
  const duplicate = op.endsWith('&') ? DESCRIPTOR.exec(src.slice(after, after + 12)) : null;
  return duplicate
    ? { token: { kind: 'redirect', takesTarget: false }, end: after + duplicate[0].length, pending: [] }
    : { token: { kind: 'redirect', takesTarget: true }, end: after, pending: [] };
}

// A number glued to `<` or `>` (`2>`) is the descriptor of that redirection.
function wordAt(src: string, i: number, pending: readonly Heredoc[]): Lexed {
  const word = readWord(src, i);
  const next = src[word.end];
  const descriptor = word.bare === word.text && /^\d+$/.test(word.text) && (next === '<' || next === '>');
  return descriptor ? { end: word.end, pending } : { token: { kind: 'word', text: word.text, glob: GLOB.test(word.bare) }, end: word.end, pending };
}

function lex(src: string, i: number, pending: readonly Heredoc[]): Lexed {
  const char = src[i]!;
  if (char === '\n') return { token: BREAK, end: skipHeredocs(src, i + 1, pending), pending: [] };
  if (/\s/.test(char)) return { end: i + 1, pending };
  if (char === '#') return { end: src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i), pending };
  const heredoc = heredocAt(src, i);
  if (heredoc) return { token: { kind: 'redirect', takesTarget: false }, end: heredoc.end, pending: [...pending, heredoc.heredoc] };
  const redirect = REDIRECTS.find((op) => src.startsWith(op, i));
  if (redirect) return { ...redirection(src, i, redirect), pending };
  const operator = OPERATORS.find((op) => src.startsWith(op, i));
  if (operator) return { token: BREAK, end: i + operator.length, pending };
  return wordAt(src, i, pending);
}

function tokenize(src: string): readonly Token[] {
  const tokens: Token[] = [];
  let pending: readonly Heredoc[] = [];
  for (let i = 0; i < src.length; ) {
    const lexed = lex(src, i, pending);
    if (lexed.token) tokens.push(lexed.token);
    pending = lexed.pending;
    i = lexed.end;
  }
  return tokens;
}

function group(tokens: readonly Token[]): ParsedShell {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let targets: string[] = [];
  let expectTarget = false;
  let glob = false;
  for (const token of [...tokens, BREAK]) {
    if (token.kind === 'break') {
      if (words.length + targets.length > 0) commands.push({ words, targets, glob });
      [words, targets, expectTarget, glob] = [[], [], false, false];
    } else if (token.kind === 'redirect') {
      expectTarget = token.takesTarget;
    } else {
      glob ||= token.glob;
      (expectTarget ? targets : words).push(token.text);
      expectTarget = false;
    }
  }
  return { commands, glob: commands.some((command) => command.glob === true) };
}

export function parseShell(src: string): ParsedShell {
  return src.length > MAX_COMMAND_LENGTH ? { commands: [], glob: false } : group(tokenize(src));
}
