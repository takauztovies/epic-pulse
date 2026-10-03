import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeHostProblem, parseHostList } from '../src/hosts.js';

// EPIC_PULSE_HOSTS names the hosts the user trusts with an Enterprise token. An
// entry that is not a host used to be dropped without a word, so a mistyped
// host looked like a token problem; doctor and the VS Code details now say
// which entry is ignored, and why.

test('a host list keeps its valid hosts, trimmed and lowercased, and passes over empty entries in silence', () => {
  assert.deepEqual(parseHostList(' GHE.Example.com ,, other.example:8443 ,'), { hosts: ['ghe.example.com', 'other.example:8443'], problems: [] });
  assert.deepEqual(parseHostList(undefined), { hosts: [], problems: [] });
  assert.deepEqual(parseHostList(' , '), { hosts: [], problems: [] });
});

// One entry per way of getting it wrong, with what to do about it.
const CASES: readonly (readonly [entry: string, reason: string])[] = [
  ['https://ghe.example.com', 'that is a URL; name the host alone, without the scheme or a path'],
  ['ghe.example.com/api', 'a path follows the host; name the host alone'],
  ['ghe.example.com?x=1', 'a path follows the host; name the host alone'],
  ['admin@ghe.example.com', 'a user name precedes the host; name the host alone'],
  ['admin@ghe.example.com/api', 'a user name precedes the host; name the host alone'],
  ['ghe example.com', 'it contains a space; separate hosts with commas'],
  ['ghe.example.com:99999999', 'a port is a colon and one to five digits, at the end'],
  ['ghe.example.com:http', 'a port is a colon and one to five digits, at the end'],
  ['-ghe.example.com', 'a host name does not begin or end with a dot or a hyphen'],
  ['ghe.example.com.', 'a host name does not begin or end with a dot or a hyphen'],
  ['ghe_example.com', 'a host name has only letters, digits, dots and hyphens, then an optional :port'],
  ['*.example.com', 'a host name has only letters, digits, dots and hyphens, then an optional :port'],
  [`${'a'.repeat(250)}.example.com`, 'it is longer than any host name'],
];

test('every entry that is not a host is reported with a reason that says how to fix it, and the valid ones around it still count', () => {
  for (const [entry, reason] of CASES) {
    const listed = parseHostList(`good.example.com, ${entry} ,also-good.example`);
    assert.deepEqual(listed.hosts, ['good.example.com', 'also-good.example'], entry);
    assert.equal(listed.problems.length, 1, entry);
    assert.equal(listed.problems[0]?.reason, reason, entry);
  }
});

// What is not a host may be anything pasted into the wrong variable, a token
// included, and the report goes to a terminal and to VS Code's log files.
test('an entry is shown as typed unless it could be a secret, is long, or holds control characters', () => {
  const shown = (entry: string) => parseHostList(entry).problems[0]?.entry;
  assert.equal(shown(' https://ghe.example.com '), 'https://ghe.example.com');
  assert.equal(shown('ghe example.com'), 'ghe example.com');
  assert.equal(shown('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), '(not shown: it looks like a token)');
  assert.equal(shown('github_pat_11AAAAAAA_secret'), '(not shown: it looks like a token)');
  assert.equal(shown('0123456789abcdefghij_0123456789'), '(not shown: it looks like a token)');
  assert.equal(shown(`${'b'.repeat(20)} ${'c'.repeat(80)}.example.com/x`), `${'b'.repeat(20)} ${'c'.repeat(39)}...`);
  assert.equal(shown('a\u0007b c'), 'a?b c');
});

test('a problem reads as one line naming the entry and the reason', () => {
  const [problem] = parseHostList('https://ghe.example.com').problems;
  assert.ok(problem, 'no problem was reported');
  assert.equal(describeHostProblem(problem), 'ignored "https://ghe.example.com": that is a URL; name the host alone, without the scheme or a path');
});
