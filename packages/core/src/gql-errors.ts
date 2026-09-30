import type { RawResponse } from './github.js';
import type { GqlError } from './schemas/graphql.js';
import type { ErrorCode } from './schemas/common.js';

// HTTP layer first: GitHub answers auth and abuse problems with a non-200 status
// and a body that is not a GraphQL envelope at all.
export function classifyHttp(res: Pick<RawResponse, 'status' | 'remaining' | 'retryAfter'>): ErrorCode | undefined {
  if (res.status === 200) return undefined;
  if (res.status === 401) return 'unauthorized';
  if (res.status === 429) return 'rate_limited';
  if (res.status === 403) return res.remaining === 0 || res.retryAfter ? 'rate_limited' : 'forbidden';
  if (res.status === 404) return 'not_found';
  return res.status >= 500 ? 'network' : 'invalid_response';
}

const UNSUPPORTED_CODES = new Set(['undefinedField', 'undefinedType', 'argumentNotAccepted']);

function codeOf(error: GqlError): ErrorCode | undefined {
  if (error.extensions?.code && UNSUPPORTED_CODES.has(error.extensions.code)) return 'unsupported';
  if (error.type === 'RATE_LIMITED') return 'rate_limited';
  if (error.type === 'FORBIDDEN' || error.type === 'INSUFFICIENT_SCOPES') return 'forbidden';
  return undefined;
}

export interface GqlOutcome {
  readonly fatal: ErrorCode | undefined;
  readonly missing: ReadonlySet<string>;
}

// A NOT_FOUND on `repository.<alias>` only means that one issue does not exist;
// the sibling aliases still carry data. A NOT_FOUND anywhere else (the
// repository itself) is fatal for the whole group. An `undefinedField` error is
// what an older GitHub Enterprise Server returns for `subIssues`, so it maps to
// `unsupported` rather than to a generic failure.
export function classifyGraphqlErrors(errors: readonly GqlError[] | undefined): GqlOutcome {
  const missing = new Set<string>();
  let fatal: ErrorCode | undefined;
  for (const error of errors ?? []) {
    const known = codeOf(error);
    const alias = error.path?.length === 2 && error.path[0] === 'repository' ? String(error.path[1]) : undefined;
    if (error.type === 'NOT_FOUND' && alias) missing.add(alias);
    else fatal ??= known ?? (error.type === 'NOT_FOUND' ? 'not_found' : 'invalid_response');
  }
  return { fatal, missing };
}
