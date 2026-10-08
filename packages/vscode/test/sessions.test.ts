import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intakeUriParts, sessionUriParts } from '../src/sessions.js';
import { SESSION_A } from './registry-helpers.js';

test('a session id becomes the Claude Code extension open URI', () => {
  assert.deepEqual(sessionUriParts(SESSION_A), { scheme: 'vscode', authority: 'anthropic.claude-code', path: '/open', query: `session=${SESSION_A}` });
});

test('anything that is not a session id is refused, so nothing else can ride in the URI', () => {
  for (const bad of ['', 'abc', `${SESSION_A}&prompt=rm`, `${SESSION_A}\n`, SESSION_A.toUpperCase(), '../../etc/passwd']) {
    assert.equal(sessionUriParts(bad), undefined, JSON.stringify(bad));
  }
});

test('an epic URL becomes a new Claude Code tab running the intake skill on it', () => {
  const url = 'https://github.com/takauztovies/epic-pulse/issues/1';
  assert.deepEqual(intakeUriParts(url), { scheme: 'vscode', authority: 'anthropic.claude-code', path: '/open', query: `prompt=/epic-pulse:intake ${url}` });
});

test('the intake prompt is rebuilt from a validated ref, so nothing but the ref can ride in it', () => {
  const parts = intakeUriParts('https://GitHub.com/TakauzTovies/Epic-Pulse/issues/1?x=1');
  assert.equal(parts?.query, 'prompt=/epic-pulse:intake https://github.com/takauztovies/epic-pulse/issues/1');
  for (const bad of ['', 'not a url', 'https://github.com/a/b/issues/1 ; rm -rf ~', 'https://github.com/a/b/issues/0']) {
    assert.equal(intakeUriParts(bad), undefined, JSON.stringify(bad));
  }
});
