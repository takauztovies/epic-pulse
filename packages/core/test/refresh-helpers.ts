import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { pathsFor, type RegistryPaths } from '../src/paths.js';
import { issueUrl, makeRef } from '../src/ref.js';
import { appendRegistryLine } from '../src/registry.js';
import type { IssueRef } from '../src/schemas/common.js';
import type { EpicEntry } from '../src/schemas/snapshot.js';
import { usageLedgerFor } from '../src/usage-ledger.js';
import { tempDir } from './repo-helpers.js';
import { noGhEnv } from './snapshot-helpers.js';

// Real refreshes of real temp registries, offline. `.invalid` never resolves
// (RFC 6761), so with a token for it every admitted request really goes out
// through fetch and really fails as `network`.

export const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

export const invalid = (number: number): IssueRef => makeRef({ host: 'epic-pulse.invalid', owner: 'acme', repo: 'widgets', number })!;

// EPIC_PULSE_HOSTS names the `.invalid` host as one the user trusts with an
// Enterprise token, so the env keeps sending where tokens go only to named hosts.
export function sendingEnv(t: TestContext, cache: string): NodeJS.ProcessEnv {
  return noGhEnv(t, { GH_ENTERPRISE_TOKEN: 'x', EPIC_PULSE_HOSTS: 'epic-pulse.invalid', EPIC_PULSE_CACHE_DIR: cache });
}

export async function bind(paths: RegistryPaths, refs: readonly IssueRef[], ts = Date.now()): Promise<void> {
  const binds = refs.map((ref) => ({ ref, via: 'gh' as const }));
  assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts, ev: 'tool', binds })).ok);
}

export async function boundRegistry(t: TestContext, refs: readonly IssueRef[]): Promise<RegistryPaths> {
  const paths = pathsFor(tempDir(t));
  await bind(paths, refs);
  return paths;
}

// Usage-ledger lines, as refreshers write them: `mine` under this registry's
// own hash, the rest under another repository's.
export function writeLedger(cache: string, lines: readonly { readonly ts: number; readonly points: number; readonly mine?: string }[]): void {
  const text = lines.map(({ ts, points, mine }) => {
    const repo = mine === undefined ? 'f'.repeat(16) : usageLedgerFor(cache, mine).repo;
    return `${JSON.stringify({ ts, host: 'epic-pulse.invalid', repo, points })}\n`;
  });
  writeFileSync(join(cache, 'usage.jsonl'), text.join(''));
}

// An epic the snapshot already holds, as a fetched checklist with one box.
export function cachedEpic(ref: IssueRef, fetchedAt: number): EpicEntry {
  const children = [{ number: null, title: 'First step', url: null, status: 'todo' as const }];
  return { ref, title: 'Epic', url: issueUrl(ref), kind: 'checklist', children, truncated: false, fetchedAt, error: null };
}
