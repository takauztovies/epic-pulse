import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLines, pinsOf, readPins, readSnapshot, refKey, sessionFile } from '@epic-pulse/core';
import { bashPayload, eventPayload } from './fixtures.js';
import { DEMO_REMOTE, registryOf, SESSION, type CliRun } from './helpers.js';
import { documentedForm, filesContaining, inventory, run, scene, type Scene } from './privacy-scene.js';

// The host a refresh sends its token to comes from repository data: the
// remote, `gh -R`, an issue URL someone tracked. A hostile checkout controls
// all of it. gh ties the Enterprise variables to no host, so epic-pulse offers
// them only to a host the user named in GH_HOST or EPIC_PULSE_HOSTS, and none
// is named here. No request is expected, so nothing here reaches the network.

const SENTINEL = 'ghp_HOSTSENTINEL00000000000000000000000';
const ENTERPRISE_ENV = { GH_ENTERPRISE_TOKEN: SENTINEL, GITHUB_ENTERPRISE_TOKEN: SENTINEL };

async function boundAndPinned(where: Scene): Promise<readonly string[]> {
  const lines = parseLines(readFileSync(sessionFile(registryOf(where.repo), SESSION)!, 'utf8'));
  const pins = pinsOf(await readPins(registryOf(where.repo)));
  return [...lines.flatMap((line) => line.binds.map((bind) => refKey(bind.ref))), ...pins.map((pin) => refKey(pin.ref))];
}

// No request, no charge, no token: what a refresh that offered nothing leaves.
async function assertNothingSent(where: Scene, runs: readonly CliRun[]): Promise<void> {
  const refreshed = await run(where, ['refresh']);
  const stopped = [1, 'epic-pulse: refreshed with 0 request(s) and 0 point(s).\n', 'epic-pulse: the refresh stopped early (no_token)\n'];
  assert.deepEqual([refreshed.code, refreshed.stdout, refreshed.stderr], stopped);
  const read = await readSnapshot(registryOf(where.repo).snapshotFile);
  assert.equal(read.status === 'ok' ? read.snapshot.error : read.status, 'no_token');
  // Every request is charged to the ledger before it is sent: no ledger, no request.
  const written = [...inventory(where).keys()].map((file) => documentedForm(where, file));
  assert.equal(written.includes('<user-cache-dir>/epic-pulse/usage.jsonl'), false);
  assert.deepEqual(filesContaining(where, SENTINEL), []);
  assert.deepEqual([...runs, refreshed].filter((r) => `${r.stdout}${r.stderr}`.includes(SENTINEL)).length, 0);
}

test('an Enterprise token is offered to no host the user never named, however the remote names it', async (t) => {
  const where = scene(t, 'https://untrusted.example/o/r', ENTERPRISE_ENV);
  const runs = [
    await run(where, ['hook'], eventPayload('SessionStart', where.repo)),
    await run(where, ['hook'], bashPayload('gh issue comment 4 -b hi', where.repo)),
    await run(where, ['doctor']),
  ];
  assert.deepEqual(await boundAndPinned(where), ['untrusted.example/o/r#4']);
  const doctor = /\n {2}token: +(.*)\n/.exec(runs[2]?.stdout ?? '')?.[1];
  const hint = 'run `gh auth login --hostname untrusted.example`, or set GH_ENTERPRISE_TOKEN and name the host in GH_HOST or EPIC_PULSE_HOSTS';
  assert.equal(doctor, `none for untrusted.example: ${hint}`);
  await assertNothingSent(where, runs);
});

test('nor to a host that `gh -R` or a tracked issue URL names', async (t) => {
  const where = scene(t, DEMO_REMOTE, ENTERPRISE_ENV);
  const runs = [
    await run(where, ['hook'], eventPayload('SessionStart', where.repo)),
    await run(where, ['hook'], bashPayload('gh issue comment 4 -R untrusted.example/o/r -b hi', where.repo)),
    await run(where, ['track', 'https://elsewhere.example/o/r/issues/7', '--repo']),
  ];
  assert.deepEqual(await boundAndPinned(where), ['untrusted.example/o/r#4', 'elsewhere.example/o/r#7']);
  await assertNothingSent(where, runs);
});
