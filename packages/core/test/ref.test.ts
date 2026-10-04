import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueUrl, makeRef, parseIssueTarget, refKey, repoKey } from '../src/ref.js';

test('refs are lowercased so case variants share one key', () => {
  const a = makeRef({ host: 'GitHub.com', owner: 'Acme', repo: 'Widgets', number: 5 })!;
  const b = makeRef({ host: 'github.com', owner: 'acme', repo: 'widgets', number: 5 })!;
  assert.equal(refKey(a), 'github.com/acme/widgets#5');
  assert.equal(refKey(a), refKey(b));
  assert.equal(repoKey(a), 'github.com/acme/widgets');
  assert.equal(issueUrl(a), 'https://github.com/acme/widgets/issues/5');
});

test('makeRef rejects anything that could escape a URL, argv or path', () => {
  const base = { host: 'github.com', owner: 'acme', repo: 'widgets', number: 5 };
  for (const bad of [
    { ...base, owner: '../x' }, { ...base, repo: 'a/b' }, { ...base, repo: '..' }, { ...base, host: '-oProxy' },
    { ...base, host: 'a b' }, { ...base, number: 0 }, { ...base, number: 1.5 }, { ...base, number: 2 ** 31 },
  ]) {
    assert.equal(makeRef(bad), undefined, JSON.stringify(bad));
  }
});

test('parseIssueTarget understands number, #number, slug and URL forms', () => {
  assert.deepEqual(parseIssueTarget('12'), { number: 12 });
  assert.deepEqual(parseIssueTarget(' #12 '), { number: 12 });
  assert.deepEqual(parseIssueTarget('Acme/Widgets#12'), { number: 12, repo: { owner: 'Acme', repo: 'Widgets' } });
  assert.deepEqual(parseIssueTarget('https://ghe.example.com/acme/widgets/issues/12#issuecomment-1'), {
    number: 12,
    repo: { host: 'ghe.example.com', owner: 'acme', repo: 'widgets' },
  });
});

test('parseIssueTarget rejects things that are not an issue reference', () => {
  for (const text of ['', 'abc', '#', '12abc', 'feature-branch', '--body', 'a/b/c#1']) {
    assert.equal(parseIssueTarget(text), undefined, text);
  }
});
