import { HostSchema } from './schemas/common.js';

// An entry of EPIC_PULSE_HOSTS that is not a host, as it is shown, and why it
// is not one. Such an entry used to be dropped without a word, so a mistyped
// host looked like a token problem.
export interface HostProblem {
  readonly entry: string;
  readonly reason: string;
}

export interface HostList {
  readonly hosts: readonly string[];
  readonly problems: readonly HostProblem[];
}

const MAX_SHOWN = 60;
const TOKEN_PREFIX = /^(?:gh[pousr]_|github_pat_)/i;
// No dot, and nothing but token characters: not a host name, a pasted secret.
const SECRET_SHAPE = /^[A-Za-z0-9_-]{20,}$/;
const REASONS = {
  url: 'that is a URL; name the host alone, without the scheme or a path',
  path: 'a path follows the host; name the host alone',
  user: 'a user name precedes the host; name the host alone',
  space: 'it contains a space; separate hosts with commas',
  long: 'it is longer than any host name',
  port: 'a port is a colon and one to five digits, at the end',
  edge: 'a host name does not begin or end with a dot or a hyphen',
  other: 'a host name has only letters, digits, dots and hyphens, then an optional :port',
};

// The first thing wrong with an entry that HostSchema refused, in the order a
// person would fix them.
function reasonFor(entry: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(entry)) return REASONS.url;
  if (entry.includes('@')) return REASONS.user;
  if (/[/?#]/.test(entry)) return REASONS.path;
  if (/\s/.test(entry)) return REASONS.space;
  if (entry.length > 255) return REASONS.long;
  if (entry.includes(':') && !/:\d{1,5}$/.test(entry)) return REASONS.port;
  return /^[.-]|[.-](?::\d+)?$/.test(entry) ? REASONS.edge : REASONS.other;
}

// What is not a host may be anything pasted into the wrong variable, a token
// included, and the report goes to a terminal and, from the VS Code extension,
// to log files. So a value shaped like a secret is not shown at all, a long one
// is cut, and a control character can not start a line of its own.
function shown(entry: string): string {
  if (TOKEN_PREFIX.test(entry) || SECRET_SHAPE.test(entry)) return '(not shown: it looks like a token)';
  const clean = [...entry].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '?' : char)).join('');
  return clean.length > MAX_SHOWN ? `${clean.slice(0, MAX_SHOWN)}...` : clean;
}

// The comma-separated EPIC_PULSE_HOSTS. Each entry is trimmed and lowercased as
// refs are, and kept only if it is a plain host; an empty one (a stray comma)
// is nothing and is passed over without a word.
export function parseHostList(text: string | undefined): HostList {
  const entries = (text ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const checked = entries.map((entry) => ({ entry, host: entry.toLowerCase() }));
  return {
    hosts: checked.filter(({ host }) => HostSchema.safeParse(host).success).map(({ host }) => host),
    problems: checked.filter(({ host }) => !HostSchema.safeParse(host).success).map(({ entry, host }) => ({ entry: shown(entry), reason: reasonFor(host) })),
  };
}

export function describeHostProblem(problem: HostProblem): string {
  return `ignored "${problem.entry}": ${problem.reason}`;
}
