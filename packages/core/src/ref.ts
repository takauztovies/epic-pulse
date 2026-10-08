import { IssueRefSchema, type IssueRef, type RefKind, type RepoRef } from './schemas/common.js';

export const DEFAULT_HOST = 'github.com';

export interface IssueTarget {
  readonly number: number;
  readonly repo?: { readonly host?: string; readonly owner: string; readonly repo: string };
  // A Jira key (PROJ-123) names a project, and the site only when it came as a
  // URL; a bare key needs the site the repository's .epic-pulse.json declares.
  readonly jira?: { readonly host?: string; readonly project: string };
}

export function kindOf(ref: RepoRef | IssueRef): RefKind {
  return ref.kind ?? 'github';
}

// Owner and repo names are case-insensitive on GitHub, so refs are lowercased at
// construction. Equality is then plain string equality on `refKey`, and a ref
// written as `Owner/Repo#5` in a commit can not create a second epic. The same
// goes for a Jira project key: the key is shown in capitals (displayKey) and
// kept in lowercase. `kind` is only stored for Jira: absent means GitHub.
export function makeRef(parts: { kind?: RefKind; host: string; owner: string; repo: string; number: number }): IssueRef | undefined {
  const parsed = IssueRefSchema.safeParse({
    ...(parts.kind === 'jira' ? { kind: 'jira' } : {}),
    host: parts.host.toLowerCase(),
    owner: parts.owner.toLowerCase(),
    repo: parts.repo.toLowerCase(),
    number: parts.number,
  });
  return parsed.success ? parsed.data : undefined;
}

export function makeJiraRef(parts: { host: string; project: string; number: number }): IssueRef | undefined {
  return makeRef({ kind: 'jira', host: parts.host, owner: parts.project, repo: parts.project, number: parts.number });
}

// The key a GitHub issue has always had stays as it was, so snapshots and
// registries written earlier still match. A Jira one is prefixed, so it can
// never equal a GitHub key.
export function repoKey(ref: RepoRef | IssueRef): string {
  return kindOf(ref) === 'jira' ? `jira:${ref.host}/${ref.owner}` : `${ref.host}/${ref.owner}/${ref.repo}`;
}

export function refKey(ref: IssueRef): string {
  return kindOf(ref) === 'jira' ? `${repoKey(ref)}-${ref.number}` : `${repoKey(ref)}#${ref.number}`;
}

// What people call an issue: `#12` on GitHub, `PROJ-12` on Jira.
export function displayKey(ref: IssueRef): string {
  return kindOf(ref) === 'jira' ? `${ref.owner.toUpperCase()}-${ref.number}` : `#${ref.number}`;
}

// The same with the repository, for a message that does not say which one is meant.
export function qualifiedKey(ref: IssueRef): string {
  return kindOf(ref) === 'jira' ? displayKey(ref) : `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function issueUrl(ref: IssueRef): string {
  if (kindOf(ref) === 'jira') return `https://${ref.host}/browse/${displayKey(ref)}`;
  return `https://${ref.host}/${ref.owner}/${ref.repo}/issues/${ref.number}`;
}

const URL_TARGET = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i;
const SLUG_TARGET = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const NUMBER_TARGET = /^#?(\d+)$/;

// Jira project keys are 2 to 10 letters, digits or underscores, starting with
// a letter. The pattern is never applied to free text without a configured
// project list (see jira-keys.ts): `UTF-8` and `SHA-256` have this shape too.
export const JIRA_KEY = /^([A-Za-z][A-Za-z0-9_]{1,9})-(\d+)$/;
const JIRA_URL = /^https?:\/\/([^/\s]+)\/browse\/([A-Za-z][A-Za-z0-9_]{1,9})-(\d+)(?:[/?#].*)?$/i;

// Accepts what people type after `gh issue close` or `epic-pulse track`:
// `5`, `#5`, `owner/repo#5`, or an issue URL (which also carries the host), and
// for Jira `PROJ-5` or its /browse/ URL.
export function parseIssueTarget(text: string): IssueTarget | undefined {
  const value = text.trim();
  const byUrl = URL_TARGET.exec(value);
  if (byUrl) {
    return { number: Number(byUrl[4]), repo: { host: byUrl[1]!.toLowerCase(), owner: byUrl[2]!, repo: byUrl[3]! } };
  }
  const byJiraUrl = JIRA_URL.exec(value);
  if (byJiraUrl) return { number: Number(byJiraUrl[3]), jira: { host: byJiraUrl[1]!.toLowerCase(), project: byJiraUrl[2]! } };
  const bySlug = SLUG_TARGET.exec(value);
  if (bySlug) return { number: Number(bySlug[3]), repo: { owner: bySlug[1]!, repo: bySlug[2]! } };
  const byKey = JIRA_KEY.exec(value);
  if (byKey) return { number: Number(byKey[2]), jira: { project: byKey[1]! } };
  const byNumber = NUMBER_TARGET.exec(value);
  return byNumber ? { number: Number(byNumber[1]) } : undefined;
}
