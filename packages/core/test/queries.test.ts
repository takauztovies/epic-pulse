import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyHttp } from '../src/gql-errors.js';
import { parsePhaseA, parsePhaseB, phaseADocument, phaseBDocument } from '../src/queries.js';
import { loadFixture } from './helpers.js';

test('phase A: sub-issue resolves to its parent, epics and missing issues are reported', () => {
  const parsed = parsePhaseA(loadFixture('phase-a'));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.rate?.cost, 1);
  assert.equal(parsed.value.issues.get(4)?.parent?.number, 1);
  assert.equal(parsed.value.issues.get(1)?.parent, null);
  assert.equal(parsed.value.issues.get(8)?.parent, null);
  assert.equal(parsed.value.issues.get(9999), null);
});

test('phase B: the sub-issue epic keeps every child with its link evidence', () => {
  const parsed = parsePhaseB(loadFixture('phase-b-subissues'));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.rate?.cost, 3);
  const epic = parsed.value.epics.get(1);
  assert.equal(epic?.subIssues.totalCount, 6);
  assert.deepEqual(epic?.subIssues.nodes.map((n) => n?.number), [2, 3, 4, 5, 6, 7]);
});

test('phase B: the checklist epic has a body and no sub-issues', () => {
  const parsed = parsePhaseB(loadFixture('phase-b-checklist'));
  assert.ok(parsed.ok);
  const epic = parsed.value.epics.get(8);
  assert.equal(epic?.subIssues.totalCount, 0);
  assert.match(epic?.body ?? '', /- \[x\] Pick a static site generator/);
});

test('a NOT_FOUND alias is a null epic, not a failure of the whole query', () => {
  const parsed = parsePhaseB(loadFixture('phase-b-missing'));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.epics.get(9999), null);
});

test('an undefinedField error means the server has no sub-issues: unsupported', () => {
  const parsed = parsePhaseB(loadFixture('error-undefined-field'));
  assert.deepEqual(parsed, { ok: false, error: { code: 'unsupported', detail: null } });
});

test('HTTP 401 with a bad credential is unauthorized', () => {
  const parsed = parsePhaseA(loadFixture('error-bad-credentials'));
  assert.deepEqual(parsed, { ok: false, error: { code: 'unauthorized', detail: 'HTTP 401' } });
});

test('a 200 that is not a GraphQL envelope is invalid_response', () => {
  const parsed = parsePhaseA({ status: 200, body: undefined, remaining: undefined, retryAfter: false });
  assert.ok(!parsed.ok);
  assert.equal(parsed.error.code, 'invalid_response');
});

test('HTTP status classification', () => {
  const at = (status: number, remaining?: number, retryAfter = false) => classifyHttp({ status, remaining, retryAfter });
  assert.equal(at(200), undefined);
  assert.equal(at(401), 'unauthorized');
  assert.equal(at(403, 0), 'rate_limited');
  assert.equal(at(403, undefined, true), 'rate_limited');
  assert.equal(at(403, 4000), 'forbidden');
  assert.equal(at(429), 'rate_limited');
  assert.equal(at(502), 'network');
  assert.equal(at(418), 'invalid_response');
});

test('every GraphQL document is a read-only query with validated numbers', () => {
  for (const document of [phaseADocument([1, 4, 8]), phaseBDocument([1, 8])]) {
    assert.match(document, /^query \w+/);
    assert.doesNotMatch(document, /\b(mutation|subscription)\b/);
  }
  assert.match(phaseADocument([4]), /i4: issue\(number: 4\)/);
  assert.match(phaseBDocument([8]), /e8: issue\(number: 8\)/);
});

test('an invalid issue number can not be interpolated into a document', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40]) {
    assert.throws(() => phaseADocument([bad]), Error, String(bad));
  }
});
