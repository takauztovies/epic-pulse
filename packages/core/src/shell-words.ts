// Readers for the pieces a shell word is made of. Each takes the source and a
// start index and returns the piece's text (quotes removed), the index just
// past it, and its unquoted characters, which are the only ones that can glob.
// Unterminated quotes and substitutions end at the end of the input.

export interface Piece {
  readonly text: string;
  readonly end: number;
  readonly bare: string;
}

export interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

const WORD_END = /[\s;&|()<>]/;
// Inside double quotes a backslash only escapes these; `\x` stays `\x`.
const QUOTED_ESCAPES = new Set(['$', '`', '"', '\\', '\n']);

function verbatim(src: string, start: number, end: number): Piece {
  return { text: src.slice(start, end), end, bare: '' };
}

function singleQuoted(src: string, start: number): Piece {
  const close = src.indexOf("'", start + 1);
  const end = close === -1 ? src.length : close;
  return { text: src.slice(start + 1, end), end: Math.min(end + 1, src.length), bare: '' };
}

// `\x` is a literal x; a backslash before a newline joins the two lines.
function escaped(src: string, start: number): Piece {
  const next = src[start + 1];
  return { text: next === undefined || next === '\n' ? '' : next, end: Math.min(start + 2, src.length), bare: '' };
}

function backquoted(src: string, start: number): Piece {
  let i = start + 1;
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return verbatim(src, start, Math.min(i + 1, src.length));
}

function quotedPiece(src: string, i: number): Piece {
  const char = src[i]!;
  const next = src[i + 1];
  if (char === '\\' && next !== undefined && QUOTED_ESCAPES.has(next)) {
    return { text: next === '\n' ? '' : next, end: i + 2, bare: '' };
  }
  if (src.startsWith('$(', i)) return substitution(src, i);
  if (char === '`') return backquoted(src, i);
  return { text: char, end: i + 1, bare: '' };
}

function doubleQuoted(src: string, start: number): Piece {
  let text = '';
  let i = start + 1;
  while (i < src.length && src[i] !== '"') {
    const piece = quotedPiece(src, i);
    text += piece.text;
    i = piece.end;
  }
  return { text, end: Math.min(i + 1, src.length), bare: '' };
}

function readPiece(src: string, i: number): Piece {
  const char = src[i]!;
  if (char === "'") return singleQuoted(src, i);
  if (char === '"') return doubleQuoted(src, i);
  if (char === '`') return backquoted(src, i);
  if (char === '\\') return escaped(src, i);
  if (src.startsWith('$(', i)) return substitution(src, i);
  return { text: char, end: i + 1, bare: char };
}

export function readWord(src: string, start: number): Piece {
  let text = '';
  let bare = '';
  let i = start;
  while (i < src.length && !WORD_END.test(src[i]!)) {
    const piece = readPiece(src, i);
    text += piece.text;
    bare += piece.bare;
    i = piece.end;
  }
  return { text, end: i, bare };
}

// `<<WORD` or `<<-WORD` (the delimiter may be quoted); not the `<<<` herestring.
export function heredocAt(src: string, i: number): { readonly heredoc: Heredoc; readonly end: number } | undefined {
  if (!src.startsWith('<<', i) || src.startsWith('<<<', i)) return undefined;
  const stripTabs = src[i + 2] === '-';
  let start = i + (stripTabs ? 3 : 2);
  while (src[start] === ' ' || src[start] === '\t') start += 1;
  const word = readWord(src, start);
  return word.text === '' ? undefined : { heredoc: { delimiter: word.text, stripTabs }, end: word.end };
}

// Skips one body per pending heredoc, starting on the line after the one that
// opened them. Returns the index just past the last delimiter line.
export function skipHeredocs(src: string, start: number, pending: readonly Heredoc[]): number {
  let i = start;
  for (const heredoc of pending) {
    for (let done = false; !done && i < src.length; ) {
      const eol = src.indexOf('\n', i);
      const line = src.slice(i, eol === -1 ? src.length : eol).replace(/\r$/, '');
      i = eol === -1 ? src.length : eol + 1;
      done = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter;
    }
  }
  return i;
}

function substitutionStep(src: string, i: number): number {
  const char = src[i];
  if (char === "'") return singleQuoted(src, i).end;
  if (char === '"') return doubleQuoted(src, i).end;
  return char === '\\' ? i + 2 : i + 1;
}

// `$( ... )` is kept verbatim, heredoc bodies included, so the text of
// `-m "$(cat <<'EOF' ... EOF)"` still carries its closing keywords. The scan
// only has to find the matching parenthesis; quotes and heredoc bodies are
// stepped over so an apostrophe in prose can not open a quote.
export function substitution(src: string, start: number): Piece {
  let depth = 0;
  let pending: readonly Heredoc[] = [];
  for (let i = start + 1; i < src.length; ) {
    const heredoc = heredocAt(src, i);
    if (src[i] === '\n' && pending.length > 0) {
      i = skipHeredocs(src, i + 1, pending);
      pending = [];
    } else if (heredoc) {
      pending = [...pending, heredoc.heredoc];
      i = heredoc.end;
    } else {
      depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
      if (depth === 0) return verbatim(src, start, i + 1);
      i = substitutionStep(src, i);
    }
  }
  return verbatim(src, start, src.length);
}
