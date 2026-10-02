import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RawResponse } from '../src/github.js';
import { refKey } from '../src/ref.js';
import { answered, type Batch, type Run } from '../src/refresh-batch.js';
import { needsResolution, RESOLUTION_TTL_MS } from '../src/refresh-plan.js';
import { emptySnapshot } from '../src/snapshot.js';
import { loadFixture } from './helpers.js';
import { demo } from './snapshot-helpers.js';

// What a refresh does with GitHub's answer to one request, fed the recorded
// responses (and bare HTTP statuses) the parse layer classifies.

const T0 = 1_800_000_000_000;
const PHASE_A: Batch = { phase: 'A', repo: { host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse' }, refs: [demo(4), demo(6)] };
const sent: Run = { now: T0, snapshot: emptySnapshot(T0), requests: 1, points: 0, failure: null };
const status = (code: number, remaining?: number): RawResponse => ({ status: code, body: null, remaining, retryAfter: false });

// Asking again would get the same answer, so it is cached like any other
// resolution: to no epic, with the code, for 30 minutes.
test('a Phase A request GitHub refuses for good is cached as no epic with its code, for 30 minutes', () => {
  const refusals = [[loadFixture('error-undefined-field'), 'unsupported'], [status(404), 'not_found'], [status(403, 4000), 'forbidden']] as const;
  for (const [response, code] of refusals) {
    const next = answered(sent, PHASE_A, response);
    assert.deepEqual([next.failure?.code, next.snapshot.issues[refKey(demo(4))]], [code, { epic: null, resolvedAt: T0, error: code }], code);
    assert.deepEqual(needsResolution(next.snapshot, PHASE_A.refs, T0 + RESOLUTION_TTL_MS - 1), [], code);
    assert.equal(needsResolution(next.snapshot, PHASE_A.refs, T0 + RESOLUTION_TTL_MS).length, 2, code);
  }
});

// A token, or time, cures these: the next run asks again.
test('a Phase A refusal that a token or time can cure caches nothing', () => {
  const curable = [[loadFixture('error-bad-credentials'), 'unauthorized'], [status(403, 0), 'rate_limited'], [status(502), 'network']] as const;
  for (const [response, code] of curable) {
    const next = answered(sent, PHASE_A, response);
    assert.deepEqual([next.failure?.code, next.snapshot.issues], [code, {}], code);
  }
});
