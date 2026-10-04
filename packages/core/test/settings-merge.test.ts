import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJson } from '../src/result.js';
import { mergeStatusLine, type StatusLineSetting } from '../src/settings-merge.js';

const OURS: StatusLineSetting = { type: 'command', command: 'node ~/.claude/epic-pulse/runtime.mjs statusline', refreshInterval: 10 };
const PLUS = `+ "statusLine": ${JSON.stringify(OURS)}`;

test('without a settings file the result holds only the status line', () => {
  assert.deepEqual(mergeStatusLine(undefined, OURS), {
    action: 'install', nextText: `${JSON.stringify({ statusLine: OURS }, null, 2)}\n`, diff: PLUS,
  });
});

test('install adds only statusLine, keeps every other key in place and writes 2-space JSON', () => {
  const existing = '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  },\n  "hooks": {}\n}\n';
  const result = mergeStatusLine(existing, OURS);
  assert.equal(result.action, 'install');
  const next = result.action === 'install' ? result.nextText : '';
  const before = parseJson(existing) as Record<string, unknown>;
  assert.deepEqual(parseJson(next), { ...before, statusLine: OURS });
  assert.deepEqual(Object.keys(parseJson(next) as object), ['model', 'permissions', 'hooks', 'statusLine']);
  assert.equal(next, `${JSON.stringify({ ...before, statusLine: OURS }, null, 2)}\n`);
  assert.match(next, /^\{\n {2}"model"/);
});

test('a null statusLine is replaced where it stands', () => {
  const result = mergeStatusLine('{"a":1,"statusLine":null,"b":2}', OURS);
  assert.equal(result.action, 'install');
  assert.deepEqual(Object.keys(parseJson(result.action === 'install' ? result.nextText : '') as object), ['a', 'statusLine', 'b']);
});

test('our command already installed is a no-op, whatever its other options', () => {
  for (const statusLine of [OURS, { type: 'command', command: `  ${OURS.command} ` }, { ...OURS, padding: 2, refreshInterval: 30 }]) {
    assert.deepEqual(mergeStatusLine(JSON.stringify({ statusLine }), OURS), { action: 'noop' }, JSON.stringify(statusLine));
  }
});

test('any other status line is refused, with the change it would have made', () => {
  const theirs = { type: 'command', command: 'my-status.sh' };
  assert.deepEqual(mergeStatusLine(JSON.stringify({ statusLine: theirs }), OURS), {
    action: 'refuse', diff: `- "statusLine": ${JSON.stringify(theirs)}\n${PLUS}`,
  });
  for (const statusLine of ['a string', 5, [], { type: 'command' }]) {
    assert.equal(mergeStatusLine(JSON.stringify({ statusLine }), OURS).action, 'refuse', JSON.stringify(statusLine));
  }
});

test('settings that are not a JSON object are left alone', () => {
  for (const text of ['', '   ', '{', '{"a":1,}', '[]', 'null', '"x"', '// comment\n{}', '﻿{}']) {
    assert.deepEqual(mergeStatusLine(text, OURS), { action: 'abort' }, JSON.stringify(text));
  }
});
