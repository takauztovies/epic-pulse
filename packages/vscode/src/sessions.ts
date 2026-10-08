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
