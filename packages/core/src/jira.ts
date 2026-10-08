import type { RawResponse } from './github.js';
import { parseJson } from './result.js';
import { HostSchema } from './schemas/common.js';

// The Jira Cloud transport, and the one rule about credentials.
//
// An Atlassian API token works for every site its account can reach, and the
// site a key belongs to comes from repository data (.epic-pulse.json, a URL) that
// a hostile checkout controls. So credentials are sent only to a site the user
// named in their own environment, JIRA_SITE (comma separated). A site that
// only the repository names gets nothing, and the refresh says "no token".

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// `https://acme.atlassian.net/` and `acme.atlassian.net` both name one site.
export function jiraSites(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const named = (env['JIRA_SITE'] ?? '').split(',').map((entry) => entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
  return new Set(named.filter((host) => HostSchema.safeParse(host).success));
}

// HTTP Basic, email and token, base64: what Jira Cloud takes. In memory only.
export function jiraCredentials(host: string, env: NodeJS.ProcessEnv): string | undefined {
  const email = (env['JIRA_EMAIL'] ?? '').trim();
  const token = (env['JIRA_API_TOKEN'] ?? '').trim();
  if (!jiraSites(env).has(host.toLowerCase()) || email === '' || token === '') return undefined;
  return Buffer.from(`${email}:${token}`).toString('base64');
}

export interface JiraSearchOptions {
  readonly host: string;
  readonly credentials: string;
  readonly jql: string;
  readonly fields: readonly string[];
  readonly maxResults: number;
  readonly nextPageToken?: string | undefined;
  readonly timeoutMs?: number;
}

export const SEARCH_PATH = '/rest/api/3/search/jql';

// Raw transport, read only. Throws on network failure: callers pass the error
// through describeFetchError, never into a message.
export async function searchJira(options: JiraSearchOptions): Promise<RawResponse> {
  const res = await fetch(`https://${options.host}${SEARCH_PATH}`, {
    method: 'POST',
    redirect: 'error', // an API endpoint never redirects; refuse rather than follow with credentials
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    headers: {
      authorization: `Basic ${options.credentials}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'epic-pulse',
    },
    body: JSON.stringify({
      jql: options.jql,
      fields: options.fields,
      maxResults: options.maxResults,
      ...(options.nextPageToken === undefined ? {} : { nextPageToken: options.nextPageToken }),
    }),
  });
  const length = Number(res.headers.get('content-length') ?? 0);
  const text = length > MAX_RESPONSE_BYTES ? '' : await res.text();
  return { status: res.status, body: parseJson(text), remaining: undefined, retryAfter: res.headers.has('retry-after') };
}
