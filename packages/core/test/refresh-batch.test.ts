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
    const next = answered(sent, PHASE_A, { res: response });
    assert.deepEqual([next.failure?.code, next.snapshot.issues[refKey(demo(4))]], [code, { epic: null, resolvedAt: T0, error: code }], code);
    assert.deepEqual(needsResolution(next.snapshot, PHASE_A.refs, T0 + RESOLUTION_TTL_MS - 1), [], code);
    assert.equal(needsResolution(next.snapshot, PHASE_A.refs, T0 + RESOLUTION_TTL_MS).length, 2, code);
  }
});

// A token, or time, cures these: the next run asks again.
test('a Phase A refusal that a token or time can cure caches nothing', () => {
  const curable = [[loadFixture('error-bad-credentials'), 'unauthorized'], [status(403, 0), 'rate_limited'], [status(502), 'network']] as const;
  for (const [response, code] of curable) {
    const next = answered(sent, PHASE_A, { res: response });
    assert.deepEqual([next.failure?.code, next.snapshot.issues], [code, {}], code);
  }
});

// A GitHub Enterprise Server with rate limiting off answers `rateLimit: null`;
// the recorded responses, with that one field as such a server sends it.
function withoutRateLimit(name: string): RawResponse {
  const res = loadFixture(name);
  const body = res.body as { readonly data: Readonly<Record<string, unknown>> };
  return { ...res, body: { ...body, data: { ...body.data, rateLimit: null } } };
}

test('an answer without a rate limit is used, charged the estimate, and leaves the known limit alone', () => {
  const limit = { remaining: 4000, resetAt: T0 + 60_000 };
  const before: Run = { ...sent, snapshot: { ...emptySnapshot(T0), rateLimit: limit } };
  const a = answered(before, { ...PHASE_A, refs: [demo(4)] }, { res: withoutRateLimit('phase-a') });
  assert.deepEqual([a.failure, a.points, a.snapshot.usage.points, a.snapshot.rateLimit, a.snapshot.issues[refKey(demo(4))]?.epic?.number], [null, 1, 1, limit, 1]);
  const b = answered(before, { ...PHASE_A, phase: 'B', refs: [demo(1)] }, { res: withoutRateLimit('phase-b-subissues') });
  assert.deepEqual([b.failure, b.points, b.snapshot.usage.points, b.snapshot.rateLimit, b.snapshot.epics[refKey(demo(1))]?.children.length], [null, 5, 5, limit, 6]);
});
