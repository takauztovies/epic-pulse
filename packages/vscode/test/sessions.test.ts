import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionUriParts } from '../src/sessions.js';
import { SESSION_A } from './registry-helpers.js';

test('a session id becomes the Claude Code extension open URI', () => {
  assert.deepEqual(sessionUriParts(SESSION_A), { scheme: 'vscode', authority: 'anthropic.claude-code', path: '/open', query: `session=${SESSION_A}` });
});

test('anything that is not a session id is refused, so nothing else can ride in the URI', () => {
  for (const bad of ['', 'abc', `${SESSION_A}&prompt=rm`, `${SESSION_A}\n`, SESSION_A.toUpperCase(), '../../etc/passwd']) {
    assert.equal(sessionUriParts(bad), undefined, JSON.stringify(bad));
  }
});
