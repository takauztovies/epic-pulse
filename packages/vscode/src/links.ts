import { z } from 'zod';

// `epicPulse.openIssue` can be run by anything in the window, with any
// argument. Only a web link leaves through it, so `command:`, `file:` or
// `vscode:` URIs can not ride on an issue click.
const IssueLinkSchema = z.url({ protocol: /^https?$/ }).max(2048);

export function issueLink(value: unknown): string | undefined {
  const parsed = IssueLinkSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
