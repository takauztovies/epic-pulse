import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHostList } from '@epic-pulse/core';
import { detailsText, refreshText } from '../src/details.js';

// An entry of EPIC_PULSE_HOSTS that is not a host used to be dropped without a
// word, so a mistyped host looked like a token problem. The details view, which
// also goes to the log, names it; the status bar and the tree stay quiet.

const BASE = { results: [], accounts: { github: false, enterprise: null }, now: Date.UTC(2026, 9, 3) };
const hostLines = (text: string) => text.split('\n').filter((line) => line.startsWith('EPIC_PULSE_HOSTS'));

test('the status details name each EPIC_PULSE_HOSTS entry that is ignored and why, and say nothing when none is', () => {
  assert.deepEqual(hostLines(detailsText({ ...BASE, hostProblems: parseHostList('ghe.example.com,other.example:8443').problems })), []);
  const problems = parseHostList('https://ghe.example.com, ok.example ,bad_host').problems;
  assert.deepEqual(hostLines(detailsText({ ...BASE, hostProblems: problems })), [
    'EPIC_PULSE_HOSTS: ignored "https://ghe.example.com": that is a URL; name the host alone, without the scheme or a path',
    'EPIC_PULSE_HOSTS: ignored "bad_host": a host name has only letters, digits, dots and hyphens, then an optional :port',
  ]);
});

test('the status details never show an ignored entry that looks like a token', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const text = detailsText({ ...BASE, hostProblems: parseHostList(secret).problems });
  assert.equal(text.includes(secret), false);
  const [line, ...others] = hostLines(text);
  assert.ok(line?.startsWith('EPIC_PULSE_HOSTS: ignored "(not shown: it looks like a token)": '), line);
  assert.equal(others.length, 0);
});

test('a refresh held back only by pacing is named, with when it can run', () => {
  const until = Date.UTC(2026, 9, 4, 14, 32);
  assert.equal(refreshText({ status: 'paced', until }), 'waiting for its turn in the hourly budget, until 2026-10-04T14:32:00.000Z');
});
