import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseHostList } from './hosts.js';
import { DEFAULT_HOST } from './ref.js';
import { parseJson } from './result.js';
import { HostSchema, type ErrorCode } from './schemas/common.js';

const run = promisify(execFile);

export type TokenSource =
  | 'GH_TOKEN'
  | 'GITHUB_TOKEN'
  | 'GH_ENTERPRISE_TOKEN'
  | 'GITHUB_ENTERPRISE_TOKEN'
  | 'gh-cli';

export interface ResolvedToken {
  readonly token: string;
  readonly source: TokenSource;
}

export interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  readonly remaining: number | undefined;
  readonly retryAfter: boolean;
}

export interface FetchFailure {
  readonly code: ErrorCode;
  readonly detail: string;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// The hosts the user named: GH_HOST, as gh reads it, and the comma-separated
// EPIC_PULSE_HOSTS (parseHostList, which also says which entries it dropped).
// Each is trimmed, lowercased as refs are, and kept only if it is a plain host.
function namedHosts(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const ghHost = (env['GH_HOST'] ?? '').trim().toLowerCase();
  return new Set([...(HostSchema.safeParse(ghHost).success ? [ghHost] : []), ...parseHostList(env['EPIC_PULSE_HOSTS']).hosts]);
}

// github.com and every other host use different env vars, like `gh` itself.
// The split is a security boundary: the host comes from repository data (a
// remote, `gh -R`, an issue URL), which a hostile checkout controls. So a
// github.com token is never offered to any other host, and the Enterprise
// variables, which gh ties to no host at all, only to a host the user named.
// Any other host gets `gh auth token` alone: a host the user logged in to
// with gh is one the user trusts.
function envNames(host: string, env: NodeJS.ProcessEnv): readonly TokenSource[] {
  if (host === DEFAULT_HOST) return ['GH_TOKEN', 'GITHUB_TOKEN'];
  return namedHosts(env).has(host) ? ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] : [];
}

// gh prefers these to its own logins: GH_ENTERPRISE_TOKEN for any host,
// GH_TOKEN for *.ghe.com. Left in its environment, gh would hand one to a host
// envNames has just refused it, so gh sees none of them and answers only with
// a login the user made. Windows reads a name in any case, so any case goes.
const TOKEN_VARIABLES: ReadonlySet<string> = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

export function ghChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !TOKEN_VARIABLES.has(name.toUpperCase()));
  return { ...Object.fromEntries(kept), GH_PROMPT_DISABLED: '1' };
}

// gh is slow to start on Windows: the test that asks it three times took 3.9 s
// and 4.1 s on idle CI runners (0.3 s on macOS), and on loaded ones its first
// question ran into the 5 s this limit used to be, which came back as "not
// logged in". Only the refresher and `doctor` wait for gh, never the hook or
// the status line, so a generous limit costs nothing but a hung gh.
const GH_TOKEN_TIMEOUT_MS = 20_000;

async function ghCliToken(host: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', host], {
      timeout: GH_TOKEN_TIMEOUT_MS,
      env: ghChildEnv(env),
      windowsHide: true,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined; // gh missing or not logged in: the caller reports no_token
  }
}

// Resolution order: env vars for the host, then `gh auth token`. The value is
// held in memory only. It is never logged and no persisted structure has a
// field for it; only the `source` label may be shown to a user.
export async function resolveToken(host: string, env: NodeJS.ProcessEnv): Promise<ResolvedToken | undefined> {
  if (!HostSchema.safeParse(host).success) return undefined;
  for (const name of envNames(host, env)) {
    const value = env[name]?.trim();
    if (value) return { token: value, source: name };
  }
  const viaCli = await ghCliToken(host, env);
  return viaCli ? { token: viaCli, source: 'gh-cli' } : undefined;
}

export function apiUrl(host: string): string {
  if (host === DEFAULT_HOST) return 'https://api.github.com/graphql';
  // GitHub Enterprise Cloud with data residency serves its API from api.<host>.
  return host.endsWith('.ghe.com') ? `https://api.${host}/graphql` : `https://${host}/api/graphql`;
}

export interface PostOptions {
  readonly host: string;
  readonly token: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

// Raw transport. Throws on network failure: callers pass the error through
// `describeFetchError`, never straight into a message or a file.
export async function postGraphql(options: PostOptions): Promise<RawResponse> {
  const res = await fetch(apiUrl(options.host), {
    method: 'POST',
    redirect: 'error', // an API endpoint never redirects; refuse rather than follow with credentials
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    headers: {
      authorization: `bearer ${options.token}`,
      'content-type': 'application/json',
      'user-agent': 'epic-pulse',
      'graphql-features': 'sub_issues',
    },
    body: JSON.stringify({ query: options.query, variables: options.variables }),
  });
  const length = Number(res.headers.get('content-length') ?? 0);
  const text = length > MAX_RESPONSE_BYTES ? '' : await res.text();
  const remaining = res.headers.get('x-ratelimit-remaining');
  return {
    status: res.status,
    body: parseJson(text),
    remaining: remaining === null ? undefined : Number(remaining),
    retryAfter: res.headers.has('retry-after'),
  };
}

// Whitelist, not redaction. Undici echoes an invalid header value verbatim in
// its message (`Headers.append: "bearer <token>" is an invalid header value`),
// so a malformed token would put the secret into any error text built from
// `err.message`. Only an errno-style code or a fixed word survives.
export function describeFetchError(err: unknown): FetchFailure {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { code: 'timeout', detail: 'TimeoutError' };
  if (err instanceof TypeError && /header value/i.test(err.message)) {
    return { code: 'invalid_token', detail: 'invalid_header_value' };
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const errno = typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(cause.code) ? cause.code : undefined;
  return { code: 'network', detail: errno ?? 'fetch_failed' };
}
