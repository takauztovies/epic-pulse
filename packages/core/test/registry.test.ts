import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathsFor } from '../src/paths.js';
import { makeRef } from '../src/ref.js';
import {
  activeBindings, appendRegistryLine, BINDING_TTL_MS, foldSession, isHookInactive, isLive, LIVE_WINDOW_MS,
  parseLines, PRUNE_AFTER_MS, pruneSessions, readLiveSessions, readSession, sessionFile,
} from '../src/registry.js';
import { RegistryLineSchema, type RegistryLine, type RegistryLineInput } from '../src/schemas/registry.js';
import { tempDir } from './repo-helpers.js';

const ID = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d';
const THIRD = '2b3c4d5e-6f7a-4b1c-8d2e-3f4a5b6c7d8e';
const ref = (number: number) => makeRef({ host: 'github.com', owner: 'acme', repo: 'widgets', number })!;
const line = (input: RegistryLineInput) => RegistryLineSchema.parse(input);

test('each hook call appends exactly one line, and the session folds from those lines', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  assert.deepEqual(await appendRegistryLine(paths, ID, { v: 1, ts: now - 2000, ev: 'start' }), { ok: true, value: undefined });
  await appendRegistryLine(paths, ID, { v: 1, ts: now - 1000, ev: 'tool', binds: [{ ref: ref(5), via: 'gh' }] });
  await appendRegistryLine(paths, ID, { v: 1, ts: now, ev: 'tool', binds: [{ ref: ref(6), via: 'branch' }], unbinds: [ref(5)] });
  assert.equal(readFileSync(sessionFile(paths, ID)!, 'utf8').split('\n').filter(Boolean).length, 3);
  const session = await readSession(paths, ID);
  assert.deepEqual(session, { id: ID, lastTs: now, ended: false, bindings: [{ ref: ref(6), via: 'branch', ts: now }] });
  assert.equal(isLive(session, now), true);
  if (process.platform !== 'win32') assert.equal(statSync(sessionFile(paths, ID)!).mode & 0o777, 0o600);
});

test('a session id that is not a Claude Code id is refused before any path is built', async (t) => {
  const dir = tempDir(t);
  const paths = pathsFor(join(dir, 'registry'));
  for (const id of ['../../escape', '', 'A0F8E7C1-2B3D-4E5F-8A9B-0C1D2E3F4A5B', `${ID}/x`, `../${ID.slice(3)}`, `${ID}\u0000`]) {
    assert.deepEqual(await appendRegistryLine(paths, id, { v: 1, ts: 1, ev: 'tool' }), { ok: false, error: 'invalid_session' }, id);
    assert.equal(sessionFile(paths, id), undefined, id);
    assert.equal(await readSession(paths, id), undefined, id);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('a malformed or oversized line is refused instead of written', async (t) => {
  const paths = pathsFor(tempDir(t));
  for (const bad of [{ v: 2, ts: 1, ev: 'tool' }, { v: 1, ts: -1, ev: 'tool' }, { v: 1, ts: 1, ev: 'other' }]) {
    assert.deepEqual(await appendRegistryLine(paths, ID, bad as RegistryLineInput), { ok: false, error: 'invalid_line' });
  }
  const long = (n: number) => makeRef({ host: 'github.com', owner: 'o'.repeat(90), repo: 'r'.repeat(90), number: n })!;
  const binds = Array.from({ length: 30 }, (_, i) => ({ ref: long(i + 1), via: 'gh' as const }));
  assert.deepEqual(await appendRegistryLine(paths, ID, { v: 1, ts: 1, ev: 'tool', binds }), { ok: false, error: 'line_too_large' });
  assert.equal(await readSession(paths, ID), undefined);
});

test('torn, invalid and foreign lines are skipped while the valid ones still count', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  await appendRegistryLine(paths, ID, { v: 1, ts: now - 10, ev: 'tool', binds: [{ ref: ref(5), via: 'gh' }] });
  appendFileSync(sessionFile(paths, ID)!, 'not json\n{"v":2,"ts":1,"ev":"tool"}\n\n{"v":1,"ts":5,"ev":"tool","binds":[{"ref":{"host":"x y"}}]}\n');
  await appendRegistryLine(paths, ID, { v: 1, ts: now, ev: 'tool', binds: [{ ref: ref(6), via: 'branch' }] });
  appendFileSync(sessionFile(paths, ID)!, '{"v":1,"ts":17');
  const session = await readSession(paths, ID);
  assert.deepEqual(session?.bindings.map((b) => b.ref.number), [5, 6]);
  assert.equal(session?.lastTs, now);
});

test('32 concurrent appends for one session leave 32 whole lines', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  const writes = Array.from({ length: 32 }, (_, i) =>
    appendRegistryLine(paths, ID, { v: 1, ts: now + i, ev: 'tool', binds: [{ ref: ref(i + 1), via: 'branch' }] }));
  assert.ok((await Promise.all(writes)).every((result) => result.ok));
  const text = readFileSync(sessionFile(paths, ID)!, 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 32);
  assert.equal(parseLines(text).length, 32);
});

test('a session is live until it ends or goes quiet for two hours', () => {
  const t0 = 1_000_000_000;
  const ended = foldSession(ID, [line({ v: 1, ts: t0, ev: 'start' }), line({ v: 1, ts: t0 + 5, ev: 'end' })])!;
  assert.equal(isLive(ended, t0 + 10), false);
  const quiet = foldSession(ID, [line({ v: 1, ts: t0, ev: 'tool' })])!;
  assert.equal(isLive(quiet, t0 + LIVE_WINDOW_MS), true);
  assert.equal(isLive(quiet, t0 + LIVE_WINDOW_MS + 1), false);
  assert.equal(foldSession(ID, []), undefined);
});

// The PostToolUse hook runs asynchronously, so one that was still starting when
// the session ended writes a tool line stamped after the end line. That is the
// last word of an ended session, and it must not bring it back to life for two
// hours; only a new SessionStart, which resuming a session writes, does.
test('a session has ended when an end line is later than its latest start; a late tool line does not revive it, a new start does', () => {
  const t0 = 1_000_000_000;
  const at = (ts: number, ev: 'start' | 'tool' | 'end', binds: readonly number[] = []) =>
    line({ v: 1, ts: t0 + ts, ev, binds: binds.map((n) => ({ ref: ref(n), via: 'gh' as const })) });
  const lateTool = foldSession(ID, [at(0, 'start'), at(3, 'tool', [5]), at(5, 'end'), at(9, 'tool', [6])])!;
  assert.deepEqual([lateTool.ended, isLive(lateTool, t0 + 10)], [true, false]);
  assert.deepEqual(lateTool.bindings.map((binding) => binding.ref.number), [5, 6], 'what the late call bound is still known');
  const resumed = foldSession(ID, [at(0, 'start'), at(5, 'end'), at(8, 'start')])!;
  assert.deepEqual([resumed.ended, isLive(resumed, t0 + 10)], [false, true]);
  const endedAgain = foldSession(ID, [at(0, 'start'), at(5, 'end'), at(8, 'start'), at(12, 'end'), at(13, 'tool')])!;
  assert.equal(endedAgain.ended, true);
  const sameInstant = foldSession(ID, [at(5, 'end'), at(5, 'start')])!;
  assert.equal(sameInstant.ended, false, 'an end that is not later than the start does not end it');
  const noStart = foldSession(ID, [at(0, 'tool'), at(5, 'end')])!;
  assert.equal(noStart.ended, true, 'a session whose start the plugin never saw still ends at its end');
});

test('lines apply in time order, not file order', () => {
  const late = foldSession(ID, [line({ v: 1, ts: 20, ev: 'tool', unbinds: [ref(5)] }), line({ v: 1, ts: 10, ev: 'tool', binds: [{ ref: ref(5), via: 'gh' }] })])!;
  assert.deepEqual(late.bindings, []);
  const endFirst = foldSession(ID, [line({ v: 1, ts: 30, ev: 'end' }), line({ v: 1, ts: 25, ev: 'tool' })])!;
  assert.equal(endFirst.ended, true);
});

test('a binding expires six hours after it was last seen; a pin does not, and stays a pin', () => {
  const t0 = 1_000_000_000;
  const session = foldSession(ID, [
    line({ v: 1, ts: t0, ev: 'tool', binds: [{ ref: ref(5), via: 'gh' }, { ref: ref(8), via: 'pin' }, { ref: ref(9), via: 'branch' }] }),
    line({ v: 1, ts: t0 + 1000, ev: 'tool', binds: [{ ref: ref(9), via: 'branch' }, { ref: ref(8), via: 'branch' }] }),
  ])!;
  const at = (now: number) => activeBindings(session, now).map((b) => `${b.via}:${b.ref.number}`);
  assert.deepEqual(at(t0 + BINDING_TTL_MS), ['gh:5', 'pin:8', 'branch:9']);
  assert.deepEqual(at(t0 + BINDING_TTL_MS + 1), ['pin:8', 'branch:9']);
  assert.deepEqual(at(t0 + 1000 + BINDING_TTL_MS + 1), ['pin:8']);
});

test('an unbind keeps later non-pin binds of that issue away for the rest of the session; only a pin lifts it', () => {
  const bind = (ts: number, number: number, via: 'branch' | 'gh' | 'closing' | 'pin') => line({ v: 1, ts, ev: 'tool', binds: [{ ref: ref(number), via }] });
  const unbind = (ts: number, number: number) => line({ v: 1, ts, ev: 'tool', unbinds: [ref(number)] });
  const untracked = [bind(10, 5, 'branch'), unbind(20, 5), bind(30, 5, 'branch'), bind(30, 6, 'branch'), bind(40, 5, 'gh'),
    line({ v: 1, ts: 50, ev: 'end' }), bind(60, 5, 'closing')];
  const at = (lines: readonly RegistryLine[]) => foldSession(ID, lines)!.bindings.map((b) => `${b.via}:${b.ref.number}@${b.ts}`);
  assert.deepEqual(at(untracked), ['branch:6@30']);
  const retracked = [...untracked, bind(70, 5, 'pin'), bind(80, 5, 'branch')];
  assert.deepEqual(at(retracked), ['branch:6@30', 'pin:5@80']);
  assert.deepEqual(at([...retracked, unbind(90, 5), bind(100, 5, 'gh')]), ['branch:6@30']);
});

test('only live sessions are listed, and a file untouched for the live window is not read', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  await appendRegistryLine(paths, ID, { v: 1, ts: now, ev: 'tool' });
  await appendRegistryLine(paths, OTHER, { v: 1, ts: now, ev: 'end' });
  await appendRegistryLine(paths, THIRD, { v: 1, ts: now, ev: 'tool' });
  const old = (now - LIVE_WINDOW_MS - 60_000) / 1000;
  utimesSync(sessionFile(paths, THIRD)!, old, old);
  writeFileSync(join(paths.sessionsDir, 'notes.txt'), 'x');
  assert.deepEqual((await readLiveSessions(paths, now)).map((s) => s.id), [ID]);
  assert.equal((await readSession(paths, THIRD))?.lastTs, now);
  assert.deepEqual(await readLiveSessions(pathsFor(join(tempDir(t), 'missing')), now), []);
});

test('a session with no registry lines means the hook is inactive', async (t) => {
  const paths = pathsFor(tempDir(t));
  assert.equal(isHookInactive(await readSession(paths, ID)), true);
  await appendRegistryLine(paths, ID, { v: 1, ts: Date.now(), ev: 'start' });
  assert.equal(isHookInactive(await readSession(paths, ID)), false);
});

test('prune deletes session files untouched for a week and leaves everything else', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  await appendRegistryLine(paths, ID, { v: 1, ts: now, ev: 'tool' });
  await appendRegistryLine(paths, OTHER, { v: 1, ts: now, ev: 'tool' });
  const weekOld = (now - PRUNE_AFTER_MS - 60_000) / 1000;
  writeFileSync(join(paths.sessionsDir, 'keep.txt'), 'x');
  for (const file of [sessionFile(paths, OTHER)!, join(paths.sessionsDir, 'keep.txt')]) utimesSync(file, weekOld, weekOld);
  assert.equal(await pruneSessions(paths, now), 1);
  assert.deepEqual(readdirSync(paths.sessionsDir).sort(), [`${ID}.jsonl`, 'keep.txt']);
  assert.equal(await pruneSessions(pathsFor(join(tempDir(t), 'missing')), now), 0);
});

test('a huge session file is read from its tail only', async (t) => {
  const paths = pathsFor(tempDir(t));
  const now = Date.now();
  await appendRegistryLine(paths, ID, { v: 1, ts: now - 5000, ev: 'tool', binds: [{ ref: ref(5), via: 'gh' }] });
  appendFileSync(sessionFile(paths, ID)!, `${JSON.stringify({ v: 1, ts: now - 4000, ev: 'tool' })}\n`.repeat(60_000)); // ~2.5 MB
  await appendRegistryLine(paths, ID, { v: 1, ts: now, ev: 'tool', binds: [{ ref: ref(6), via: 'branch' }] });
  const session = await readSession(paths, ID);
  assert.deepEqual(session?.bindings.map((b) => b.ref.number), [6]);
  assert.equal(session?.lastTs, now);
});
