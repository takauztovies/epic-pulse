import { IssueRefSchema, type IssueRef, type RepoRef } from './schemas/common.js';

export const DEFAULT_HOST = 'github.com';

export interface IssueTarget {
  readonly number: number;
  readonly repo?: { readonly host?: string; readonly owner: string; readonly repo: string };
}

// Owner and repo names are case-insensitive on GitHub, so refs are lowercased at
// construction. Equality is then plain string equality on `refKey`, and a ref
// written as `Owner/Repo#5` in a commit can not create a second epic.
export function makeRef(parts: { host: string; owner: string; repo: string; number: number }): IssueRef | undefined {
  const parsed = IssueRefSchema.safeParse({
    host: parts.host.toLowerCase(),
    owner: parts.owner.toLowerCase(),
    repo: parts.repo.toLowerCase(),
    number: parts.number,
  });
  return parsed.success ? parsed.data : undefined;
}

export function repoKey(ref: RepoRef | IssueRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}`;
}

export function refKey(ref: IssueRef): string {
  return `${repoKey(ref)}#${ref.number}`;
}

export function issueUrl(ref: IssueRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/issues/${ref.number}`;
}

const URL_TARGET = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i;
const SLUG_TARGET = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const NUMBER_TARGET = /^#?(\d+)$/;

// Accepts what people type after `gh issue close` or `epic-pulse track`:
// `5`, `#5`, `owner/repo#5`, or an issue URL (which also carries the host).
export function parseIssueTarget(text: string): IssueTarget | undefined {
  const value = text.trim();
  const byUrl = URL_TARGET.exec(value);
  if (byUrl) {
    return { number: Number(byUrl[4]), repo: { host: byUrl[1]!.toLowerCase(), owner: byUrl[2]!, repo: byUrl[3]! } };
  }
  const bySlug = SLUG_TARGET.exec(value);
  if (bySlug) return { number: Number(bySlug[3]), repo: { owner: bySlug[1]!, repo: bySlug[2]! } };
  const byNumber = NUMBER_TARGET.exec(value);
  return byNumber ? { number: Number(byNumber[1]) } : undefined;
}
