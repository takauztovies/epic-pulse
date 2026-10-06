import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addPin, appendRegistryLine, applyEpics, applyResolutions, emptySnapshot, makeRef, parsePhaseA, parsePhaseB, pathsFor,
  writeSnapshot, type IssueRef, type RawResponse, type Snapshot,
} from '@epic-pulse/core';
import { z } from 'zod';
import type { RepoTarget } from '../src/repos.js';

// Real registries in real temp directories, written through core's own
// writers, and snapshots built from the recorded demo responses exactly the
// way the refresher applies them. No part of core is replaced.

const FIXTURES = fileURLToPath(new URL('../../../fixtures/graphql/', import.meta.url));
const RecordingSchema = z.object({ status: z.number(), remaining: z.number().nullable(), retryAfter: z.boolean(), body: z.unknown() });

export const SESSION_A = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
export const SESSION_B = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';

// The canonical spelling, the one the product reduces every path to: `native`
// expands the 8.3 short names (C:\Users\RUNNER~1) that os.tmpdir() hands out
// on a Windows runner and git never writes, which the JS realpath leaves alone.
export function tempDir(t: TestContext, prefix = 'ep-vscode-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function loadFixture(name: string): RawResponse {
  const recording = RecordingSchema.parse(JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')));
  return { status: recording.status, body: recording.body, remaining: recording.remaining ?? undefined, retryAfter: recording.retryAfter };
}

export const demo = (number: number): IssueRef => makeRef({ host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse', number })!;

// #4 resolves to epic #1 (sub-issues in every status), #1 and #8 (a checklist
// epic) to themselves.
export function demoSnapshot(now: number): Snapshot {
  const a = parsePhaseA(loadFixture('phase-a'));
  const subIssues = parsePhaseB(loadFixture('phase-b-subissues'));
  const checklist = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(a.ok && subIssues.ok && checklist.ok);
  const resolved = applyResolutions(emptySnapshot(now), [1, 4, 8].map((n) => [demo(n), a.value.issues.get(n) ?? null] as const), now);
  return applyEpics(resolved, [[demo(1), subIssues.value.epics.get(1) ?? null], [demo(8), checklist.value.epics.get(8) ?? null]], now);
}

export interface SessionSpec {
  readonly id: string;
  readonly binds: readonly IssueRef[];
}

export interface RegistrySpec {
  readonly sessions?: readonly SessionSpec[];
  readonly pins?: readonly IssueRef[];
  readonly snapshot?: Snapshot;
}

// A session with no binds still gets its start line, as the hook writes one.
async function writeSession(dir: string, session: SessionSpec, now: number): Promise<void> {
  const binds = session.binds.map((ref) => ({ ref, via: 'gh' as const }));
  const line = { v: 1, ts: now, ev: binds.length > 0 ? 'tool' : 'start', binds } as const;
  assert.ok((await appendRegistryLine(pathsFor(dir), session.id, line)).ok);
}

export async function makeRegistry(t: TestContext, spec: RegistrySpec, now = Date.now()): Promise<RepoTarget> {
  const dir = join(tempDir(t), 'epic-pulse');
  for (const session of spec.sessions ?? []) await writeSession(dir, session, now);
  for (const ref of spec.pins ?? []) assert.ok((await addPin(pathsFor(dir), ref, now)).ok);
  if (spec.snapshot) await writeSnapshot(pathsFor(dir).snapshotFile, spec.snapshot);
  return { dir, folder: dirname(dir), label: 'demo' };
}

// An empty PATH, so `gh` can not be found and only env vars supply a token,
// and a private cache directory, so no test reads or charges the user's real
// usage ledger.
export function noGhEnv(t: TestContext, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: tempDir(t, 'ep-nogh-'), EPIC_PULSE_CACHE_DIR: tempDir(t, 'ep-cache-'), ...extra };
}

export function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
