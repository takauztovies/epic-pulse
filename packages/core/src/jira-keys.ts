import type { JiraConfig } from './jira-config.js';
import { makeJiraRef } from './ref.js';
import type { IssueRef } from './schemas/common.js';

// Jira issue keys in free text (a branch name, a commit message), but only for
// the projects the repository configured: `UTF-8`, `SHA-256` and `ISO-9660`
// look exactly like keys. A key is not part of a longer word or number, so
// `XPROJ-12` and `PROJ-123456789012` are not PROJ-12.
const MAX_TEXT = 4000;
const MAX_NUMBER_DIGITS = 9;

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

export function jiraKeysIn(text: string, jira: JiraConfig): readonly IssueRef[] {
  const projects = jira.projects.map(escapeRegExp).join('|');
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${projects})-(\\d{1,${MAX_NUMBER_DIGITS}})(?![0-9A-Za-z_])`, 'gi');
  const found = [...text.slice(0, MAX_TEXT).matchAll(pattern)].flatMap((match) => {
    const ref = makeJiraRef({ host: jira.site, project: match[1] ?? '', number: Number(match[2]) });
    return ref ? [ref] : [];
  });
  return found.filter((ref, index) => found.findIndex((other) => other.owner === ref.owner && other.number === ref.number) === index);
}
