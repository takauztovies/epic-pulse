import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RawResponse } from '../src/github.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/graphql/', import.meta.url));

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
