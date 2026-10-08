import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RawResponse } from '../src/github.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/graphql/', import.meta.url));
const JIRA_FIXTURES = fileURLToPath(new URL('../../../fixtures/jira/', import.meta.url));

const RecordingSchema = z.object({
  status: z.number(),
  remaining: z.number().nullable(),
  retryAfter: z.boolean(),
  body: z.unknown(),
});

// Fixtures are real responses recorded by scripts/record-fixtures.mjs, fed to
// the parse layer unchanged.
export function loadFixture(name: string): RawResponse {
  const text = readFileSync(`${FIXTURES}${name}.json`, 'utf8');
  const recording = RecordingSchema.parse(JSON.parse(text));
  return {
    status: recording.status,
    body: recording.body,
    remaining: recording.remaining ?? undefined,
    retryAfter: recording.retryAfter,
  };
}

// Jira recordings: the same shape, from fixtures/jira.
export function loadJiraFixture(name: string): RawResponse {
  const recording = RecordingSchema.parse(JSON.parse(readFileSync(`${JIRA_FIXTURES}${name}.json`, 'utf8')));
  return { status: recording.status, body: recording.body, remaining: recording.remaining ?? undefined, retryAfter: recording.retryAfter };
}
