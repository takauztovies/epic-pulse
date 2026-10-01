import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeMarkdown } from '../src/markdown.js';
import { issueLink } from '../src/links.js';
import { MAX_REFRESH_SECONDS, MIN_REFRESH_SECONDS, parseSettings } from '../src/settings.js';

// Values that cross into the extension from outside: settings.json, command
// arguments, issue titles.

test('settings fall back to their defaults and are held inside the bounds the manifest declares', () => {
  const at = (refreshSeconds: unknown) => parseSettings({ refreshSeconds, statusBarEnabled: undefined }).refreshSeconds;
  assert.deepEqual(parseSettings({ refreshSeconds: undefined, statusBarEnabled: undefined }), { refreshSeconds: 60, statusBarEnabled: true });
  assert.deepEqual([at(10), at(45.7), at(MIN_REFRESH_SECONDS), at(1e12), at(Infinity), at('90'), at(null)], [30, 45, 30, MAX_REFRESH_SECONDS, 60, 60, 60]);
  // Past 2^31-1 ms Node fires a timer after 1 ms instead, so the ceiling must stay below it.
  assert.ok(MAX_REFRESH_SECONDS * 1000 < 2 ** 31 - 1);
  assert.equal(parseSettings({ refreshSeconds: 60, statusBarEnabled: false }).statusBarEnabled, false);
  assert.equal(parseSettings({ refreshSeconds: 60, statusBarEnabled: 'no' }).statusBarEnabled, true);
});

test('openIssue lets only http(s) links through, whatever runs the command', () => {
  const issue = 'https://github.com/takauztovies/epic-pulse/issues/4';
  assert.equal(issueLink(issue), issue);
  assert.equal(issueLink('http://ghes.example/acme/widgets/issues/1'), 'http://ghes.example/acme/widgets/issues/1');
  for (const value of ['command:workbench.action.terminal.new', 'file:///etc/passwd', 'vscode://settings', 'javascript:alert(1)', '', 4, undefined]) {
    assert.equal(issueLink(value), undefined, String(value));
  }
  assert.equal(issueLink(`https://github.com/${'a'.repeat(3000)}`), undefined);
});

test('escaping keeps a title readable while taking every Markdown meaning out of it', () => {
  assert.equal(escapeMarkdown('Fix [login](https://x.invalid)\nnow'), 'Fix \\[login\\]\\(https\\://x\\.invalid\\) now');
  assert.equal(escapeMarkdown('plain words'), 'plain words');
});
