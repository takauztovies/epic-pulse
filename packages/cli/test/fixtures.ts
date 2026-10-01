import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  applyEpics, applyResolutions, emptySnapshot, makeRef, parsePhaseA, parsePhaseB,
  type IssueRef, type RawResponse, type Snapshot,
} from '@epic-pulse/core';
import { SESSION } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/graphql/', import.meta.url));

const RecordingSchema = z.object({ status: z.number(), remaining: z.number().nullable(), retryAfter: z.boolean(), body: z.unknown() });

// Real responses recorded from the public demo repository, fed to core's
// parse layer unchanged.
function loadFixture(name: string): RawResponse {
  const recording = RecordingSchema.parse(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')));
  return { status: recording.status, body: recording.body, remaining: recording.remaining ?? undefined, retryAfter: recording.retryAfter };
}

export const demo = (number: number): IssueRef => makeRef({ host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse', number })!;

// Applied the way the refresher applies them: #4 resolves to epic #1, while #1
// and the checklist epic #8 resolve to themselves.
export function demoSnapshot(now: number): Snapshot {
  const a = parsePhaseA(loadFixture('phase-a'));
  const subIssues = parsePhaseB(loadFixture('phase-b-subissues'));
  const checklist = parsePhaseB(loadFixture('phase-b-checklist'));
  if (!a.ok || !subIssues.ok || !checklist.ok) throw new Error('the recorded fixtures no longer parse');
  const resolved = applyResolutions(emptySnapshot(now), [1, 4, 8].map((n) => [demo(n), a.value.issues.get(n) ?? null] as const), now);
  return applyEpics(resolved, [[demo(1), subIssues.value.epics.get(1) ?? null], [demo(8), checklist.value.epics.get(8) ?? null]], now);
}

// Payloads shaped like Claude Code's, with only the fields a real one carries.
export function bashPayload(command: string, cwd: string, session = SESSION): string {
  return JSON.stringify({
    session_id: session, transcript_path: '/dev/null', cwd, hook_event_name: 'PostToolUse',
    tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_response: { stdout: '', stderr: '', interrupted: false },
  });
}

export function eventPayload(event: 'SessionStart' | 'SessionEnd', cwd: string, session = SESSION): string {
  return JSON.stringify({ session_id: session, transcript_path: '/dev/null', cwd, hook_event_name: event, source: 'startup' });
}

export function statusPayload(cwd: string, session = SESSION): string {
  return JSON.stringify({
    hook_event_name: 'Status', session_id: session, transcript_path: '/dev/null', cwd,
    model: { id: 'claude', display_name: 'Claude' }, workspace: { current_dir: cwd, project_dir: cwd }, version: '2.1.283',
  });
}
