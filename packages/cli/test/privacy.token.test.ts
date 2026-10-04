import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { readSnapshot } from '@epic-pulse/core';
import { bashPayload, eventPayload } from './fixtures.js';
import { registryOf, type CliRun } from './helpers.js';
import { documentedFiles, documentedForm, filesContaining, inventory, run, scene, type Scene } from './privacy-scene.js';

// A token must reach no file and no output, even on the paths that hold it.
// The repository's remote is an Enterprise host on 127.0.0.1:1, a port fetch
// refuses inside the process ("bad port"). EPIC_PULSE_HOSTS names it, so a
// real refresh resolves the token, charges the ledger and sends the request,
// yet nothing leaves the machine and no server, real or fake, is involved.

const SENTINEL = 'ghp_PRIVACYSENTINEL000000000000000000000';
const REMOTE = 'https://127.0.0.1:1/takauztovies/epic-pulse.git';

function tokenEnv(token: string): NodeJS.ProcessEnv {
  return { GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token, GH_TOKEN: token, GITHUB_TOKEN: token, EPIC_PULSE_HOSTS: '127.0.0.1:1' };
}

interface Outcome {
  readonly where: Scene;
  readonly runs: readonly CliRun[];
  // The files the run created, as the README writes them.
  readonly created: readonly string[];
}

// A session that comments on #4, a repository pin on #8, a refresh that
// fails the way it is meant to, and a doctor run that reads the token.
async function refreshWith(t: TestContext, token: string, code: string): Promise<Outcome> {
  const where = scene(t, REMOTE, tokenEnv(token));
  const before = inventory(where);
  const runs = [
    await run(where, ['hook'], eventPayload('SessionStart', where.repo)),
    await run(where, ['hook'], bashPayload('gh issue comment 4 -b hi', where.repo)),
    await run(where, ['track', '8', '--repo']),
  ];
  const refreshed = await run(where, ['refresh']);
  assert.deepEqual([refreshed.code, refreshed.stderr], [1, `epic-pulse: the refresh stopped early (${code})\n`]);
  const doctor = await run(where, ['doctor']);
  assert.match(doctor.stdout, /token: +from GH_ENTERPRISE_TOKEN\b/);
  const created = [...inventory(where).keys()].filter((file) => !before.has(file)).map((file) => documentedForm(where, file));
  return { where, runs: [...runs, refreshed, doctor], created };
}

// Proof the token was really in hand: a request was reserved in the ledger.
function chargedPoints(where: Scene): number {
  const ledger = [...inventory(where).keys()].find((file) => documentedForm(where, file) === '<user-cache-dir>/epic-pulse/usage.jsonl');
  assert.ok(ledger, 'no usage ledger was written, so no request was ever attempted');
  return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line) as { points: number }).points, 0);
}

function assertNowhere(where: Scene, runs: readonly CliRun[], needle: string): void {
  assert.deepEqual(filesContaining(where, needle), []);
  assert.deepEqual(runs.filter((r) => `${r.stdout}${r.stderr}`.includes(needle)).map((r) => r.stdout.split('\n')[0]), []);
}

// The refresh that made a request also writes the files the cached run in
// privacy.files.test.ts can not: the ledger. Every file is still documented.
test('a token the refresher sends is on no file and in no output', async (t) => {
  const { where, runs, created } = await refreshWith(t, SENTINEL, 'network');
  assert.ok(chargedPoints(where) >= 1);
  assertNowhere(where, runs, SENTINEL);
  const read = await readSnapshot(registryOf(where.repo).snapshotFile);
  assert.deepEqual(read.status === 'ok' ? [read.snapshot.error, read.snapshot.detail] : read.status, ['network', 'fetch_failed']);
  assert.ok(created.includes('<user-cache-dir>/epic-pulse/usage.jsonl'), 'the ledger is not where the README says');
  assert.deepEqual(created.filter((file) => !documentedFiles().includes(file)), []);
});

// Undici puts a malformed header value, token and all, into its error
// message; only a whitelisted code may reach the snapshot.
test('a malformed token, which the HTTP client echoes in its error, is on no file and in no output', async (t) => {
  const { where, runs } = await refreshWith(t, `${SENTINEL}\nx`, 'invalid_token');
  assert.ok(chargedPoints(where) >= 1);
  assertNowhere(where, runs, SENTINEL);
  const read = await readSnapshot(registryOf(where.repo).snapshotFile);
  assert.deepEqual(read.status === 'ok' ? [read.snapshot.error, read.snapshot.detail] : read.status, ['invalid_token', 'invalid_header_value']);
});
