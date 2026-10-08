import { issueUrl, makeRef, parseIssueTarget } from '@epic-pulse/core';

// The Claude Code extension opens or focuses a session from
// vscode://anthropic.claude-code/open?session=<id>. An id comes from registry
// files, so it is checked against the hook's own session-id shape before it
// is put in a URI; anything else is refused rather than escaped.
const SESSION_ID = /^[0-9a-f-]{36}$/;

export interface SessionUriParts {
  readonly scheme: 'vscode';
  readonly authority: 'anthropic.claude-code';
  readonly path: '/open';
  readonly query: string;
}

export function sessionUriParts(id: string): SessionUriParts | undefined {
  return SESSION_ID.test(id) ? { scheme: 'vscode', authority: 'anthropic.claude-code', path: '/open', query: `session=${id}` } : undefined;
}

// A new Claude Code tab whose prompt is the intake skill pointed at one epic.
// The URL in the prompt is rebuilt from a validated ref, never taken as it
// came, so only the characters a ref allows can end up in the prompt.
export function intakeUriParts(epicUrl: string): SessionUriParts | undefined {
  const target = parseIssueTarget(epicUrl);
  const own = target?.repo;
  const ref = target && own ? makeRef({ host: own.host ?? 'github.com', owner: own.owner, repo: own.repo, number: target.number }) : undefined;
  return ref ? { scheme: 'vscode', authority: 'anthropic.claude-code', path: '/open', query: `prompt=/epic-pulse:intake ${issueUrl(ref)}` } : undefined;
}

// The ids a click hands to openSession: the first argument, an array of strings.
// Anything else (a stray argument from the palette, a malformed command) is no ids.
export function sessionIdsFrom(argument: unknown): readonly string[] {
  return Array.isArray(argument) ? argument.filter((id): id is string => typeof id === 'string') : [];
}
