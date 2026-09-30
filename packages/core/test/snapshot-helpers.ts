import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { parsePhaseA, parsePhaseB } from '../src/queries.js';
import { makeRef } from '../src/ref.js';
import { applyEpics, applyResolutions } from '../src/refresh-apply.js';
import type { IssueRef } from '../src/schemas/common.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { emptySnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';

export const demo = (number: number): IssueRef => makeRef({ host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse', number })!;

// The recorded demo responses, applied exactly the way the refresher applies
// them: #4 resolves to epic #1, #1 and #8 to themselves.
export function demoSnapshot(now: number): Snapshot {
  const a = parsePhaseA(loadFixture('phase-a'));
  const subIssues = parsePhaseB(loadFixture('phase-b-subissues'));
  const checklist = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(a.ok && subIssues.ok && checklist.ok);
  const resolved = applyResolutions(emptySnapshot(now), [1, 4, 8].map((n) => [demo(n), a.value.issues.get(n) ?? null] as const), now);
  return applyEpics(resolved, [[demo(1), subIssues.value.epics.get(1) ?? null], [demo(8), checklist.value.epics.get(8) ?? null]], now);
}

// An empty PATH: `gh` can not be found, so only env vars can supply a token.
export function noGhEnv(t: TestContext, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'ep-nogh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { PATH: dir, ...extra };
}

export function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
