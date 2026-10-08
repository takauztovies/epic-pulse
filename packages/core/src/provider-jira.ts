import { describeFetchError, type RawResponse } from './github.js';
import { classifyHttp } from './gql-errors.js';
import { jiraCredentials, searchJira } from './jira.js';
import { epicAnswers, resolutionAnswers } from './jira-epic.js';
import type { Parsed, Provider, ProviderSettings } from './provider.js';
import type { Failure } from './queries.js';
import { applyBuiltEpics, applyResolutions } from './refresh-apply.js';
import type { Batch } from './refresh-batch.js';
import { displayKey, JIRA_KEY } from './ref.js';
import { fail, ok, type Result } from './result.js';
import type { IssueRef } from './schemas/common.js';
import { JiraPhaseASchema, JiraPhaseBSchema, type JiraIssue } from './schemas/jira.js';

// Jira Cloud behind the Provider interface. Read only: it searches, nothing else.
const RESOLVE_FIELDS = ['summary', 'parent'];
const EPIC_FIELDS = ['summary', 'description', 'created'];
const CHILD_FIELDS = ['summary', 'status', 'resolution', 'resolutiondate', 'assignee', 'labels'];
const PAGE_SIZE = 100;
// 5 pages of 100 is the most an epic keeps (MAX_CHILDREN); Atlassian's paging
// has been inconsistent (maxResults ignored, isLast or the token missing), so
// the loop ends on its own signals and on this cap, never on trust.
const MAX_PAGES = 5;

// Only keys of the shape Jira issues have go into a query, so nothing a
// registry file or a URL carries can add to the JQL.
function keysOf(refs: readonly IssueRef[]): readonly string[] {
  return refs.map(displayKey).filter((key) => JIRA_KEY.test(key));
}

const inList = (field: string, keys: readonly string[]) => `${field} in (${keys.join(',')})`;

async function childrenOf(host: string, credentials: string, key: string): Promise<Result<{ issues: readonly JiraIssue[]; complete: boolean }, RawResponse>> {
  const issues: JiraIssue[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await searchJira({ host, credentials, jql: `parent = ${key}`, fields: CHILD_FIELDS, maxResults: PAGE_SIZE, nextPageToken: token });
    const parsed = JiraPhaseASchema.safeParse(res.body);
    if (res.status !== 200 || !parsed.success) return fail(res);
    issues.push(...parsed.data.issues);
    token = parsed.data.nextPageToken;
    if (parsed.data.isLast === true || token === undefined) return ok({ issues, complete: true });
  }
  return ok({ issues, complete: false });
}

async function sendB(credentials: string, batch: Batch, keys: readonly string[]): Promise<RawResponse> {
  const epics = await searchJira({ host: batch.repo.host, credentials, jql: inList('key', keys), fields: EPIC_FIELDS, maxResults: keys.length });
  if (epics.status !== 200) return epics;
  const children: Record<string, { issues: readonly JiraIssue[]; complete: boolean }> = {};
  for (const key of keys) {
    const found = await childrenOf(batch.repo.host, credentials, key);
    if (!found.ok) return found.error;
    children[key] = found.value;
  }
  return { status: 200, body: { epics: epics.body, children }, remaining: undefined, retryAfter: false };
}

async function send(credentials: string, batch: Batch): Promise<Result<RawResponse, Failure>> {
  const keys = keysOf(batch.refs);
  if (keys.length === 0) return fail({ code: 'invalid_response', detail: 'no_valid_key' });
  try {
    if (batch.phase === 'B') return ok(await sendB(credentials, batch, keys));
    return ok(await searchJira({ host: batch.repo.host, credentials, jql: inList('key', keys), fields: RESOLVE_FIELDS, maxResults: keys.length }));
  } catch (error) {
    return fail(describeFetchError(error));
  }
}

function parse(batch: Batch, res: RawResponse, settings: ProviderSettings): Result<Parsed, Failure> {
  const code = classifyHttp(res);
  if (code) return fail({ code, detail: `http_${res.status}` });
  if (batch.phase === 'A') {
    const parsed = JiraPhaseASchema.safeParse(res.body);
    if (!parsed.success) return fail({ code: 'invalid_response', detail: 'jira_shape' });
    const answers = resolutionAnswers(batch.refs, parsed.data);
    return ok({ rate: null, apply: (snapshot, now) => applyResolutions(snapshot, answers, now) });
  }
  const parsed = JiraPhaseBSchema.safeParse(res.body);
  if (!parsed.success) return fail({ code: 'invalid_response', detail: 'jira_shape' });
  const answers = epicAnswers(batch.refs, parsed.data, settings.jira);
  return ok({ rate: null, apply: (snapshot, now) => applyBuiltEpics(snapshot, answers, now) });
}

export const JIRA: Provider = {
  kind: 'jira',
  token: (host, env) => Promise.resolve(jiraCredentials(host, env)),
  send,
  parse,
};
