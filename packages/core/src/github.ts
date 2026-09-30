import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

// github.com and GitHub Enterprise Server use different env vars, exactly like
// `gh` itself. The split is a security boundary: the host comes from a git
// remote, which a hostile checkout controls, so a github.com token must never be
// offered to any other host.
function envNames(host: string): readonly TokenSource[] {
  return host === DEFAULT_HOST ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
}

async function ghCliToken(host: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', host], {
      timeout: 5000,
      env: { ...env, GH_PROMPT_DISABLED: '1' },
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
  for (const name of envNames(host)) {
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
