import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeRef, type IssueRef } from '@epic-pulse/core';
import { detailsText, errorLabel, outcomeLine } from '../src/details.js';
import { enterpriseHostOf, grantOf, sessionRequests, tokenUse } from '../src/grant.js';
import { buildModel, signedOutHosts } from '../src/model.js';
import { pollAll } from '../src/poll.js';
import { configureMessage, signInStep } from '../src/sign-in.js';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { filesUnder, makeRegistry, noGhEnv, SESSION_A } from './registry-helpers.js';

const SENTINEL = 'SENTINEL-5b1e-never-persist';
const HOST = 'epic-pulse.invalid';
const invalid = (number: number, host = HOST): IssueRef => makeRef({ host, owner: 'acme', repo: 'widgets', number })!;

// No server is involved: `.invalid` never resolves (RFC 6761), so the token
// really goes out through fetch and really fails, offline. A NUL makes the
// header itself invalid, the path where undici echoes the header value, token
// included, in its message. The token arrives the way VS Code hands it over:
// as a GitHub Enterprise sign-in for that host.
test('a VS Code token reaches no file a refresh writes, and nothing the extension shows or logs', async (t) => {
  for (const [token, code] of [[SENTINEL, 'network'], [`${SENTINEL}\u0000x`, 'invalid_token']] as const) {
    const now = Date.now();
    const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [invalid(4)] }] }, now);
    const env = noGhEnv(t);
    const results = await pollAll([repo], { now, env, grant: grantOf({ 'github-enterprise': token }, HOST) });
    assert.deepEqual([results[0]?.token, results[0]?.refresh], ['session', { status: 'done', requests: 1, points: 0, error: code }]);
    const cache = env['EPIC_PULSE_CACHE_DIR'] ?? assert.fail('no cache dir');
    const files = [...filesUnder(repo.dir), ...filesUnder(cache)];
    assert.ok(files.includes(join(repo.dir, 'snapshot.json')) && files.includes(join(cache, 'usage.jsonl')), 'nothing was written');
    for (const file of files) assert.equal(readFileSync(file, 'utf8').includes('SENTINEL'), false, file);
    const model = buildModel({ results, now });
    const details = detailsText({ results, accounts: { github: false, enterprise: HOST }, hostProblems: [], now });
    const shown = [JSON.stringify(results), JSON.stringify(treeOf(model)), JSON.stringify(statusBarOf(model)), details, ...results.map(outcomeLine)];
    for (const text of shown) assert.equal(text.includes('SENTINEL'), false, text.slice(0, 300));
  }
});

// Every request is charged to the ledger, under its host, before it is sent.
function chargedHosts(cache: string): readonly string[] {
  const file = join(cache, 'usage.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((raw) => String((JSON.parse(raw) as Record<string, unknown>)['host']));
}

// The sign-in's host gets its token; the other host gets none from VS Code,
// and with no variable and no gh core finds none either, so nothing is sent
// there. The environment the poll was given is frozen: nothing writes to it.
test('the token of a sign-in goes to its own host, and another host in the registry does not hold it back', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [invalid(4), invalid(5, 'elsewhere.invalid')] }] }, now);
  const env = Object.freeze(noGhEnv(t));
  const results = await pollAll([repo], { now, env, grant: grantOf({ 'github-enterprise': SENTINEL }, HOST) });
  const refreshed = results[0]?.refresh;
  assert.deepEqual([results[0]?.token, refreshed?.status === 'done' ? refreshed.requests : refreshed], ['session', 1]);
  assert.deepEqual(chargedHosts(env['EPIC_PULSE_CACHE_DIR'] ?? assert.fail('no cache dir')), [HOST]);
});

test('each sign-in is read silently, and the Enterprise one only when a server is configured', () => {
  const silent = { scopes: ['repo'], options: { createIfNone: false, silent: true } };
  assert.deepEqual(sessionRequests(undefined), [{ provider: 'github', ...silent }]);
  assert.deepEqual(sessionRequests('ghes.example'), [{ provider: 'github', ...silent }, { provider: 'github-enterprise', ...silent }]);
});

test('each token is keyed by the host its sign-in belongs to: github.com for GitHub, the configured server for Enterprise', () => {
  assert.deepEqual(grantOf({ github: 'gho', 'github-enterprise': 'ghes' }, 'ghes.example'), { 'github.com': 'gho', 'ghes.example': 'ghes' });
  assert.deepEqual(grantOf({ github: 'gho' }, 'ghes.example'), { 'github.com': 'gho' });
  assert.deepEqual(grantOf({ 'github-enterprise': 'ghes' }, 'ghes.example'), { 'ghes.example': 'ghes' });
  // Without a configured server an Enterprise token has no host it belongs to.
  assert.deepEqual(grantOf({ 'github-enterprise': 'ghes' }, undefined), {});
  // A provider without a session answers undefined, which readAuth passes on as it is.
  assert.deepEqual(grantOf({ github: undefined, 'github-enterprise': undefined }, 'ghes.example'), {});
  assert.deepEqual([grantOf({}, 'ghes.example'), grantOf({}, undefined)], [{}, {}]);
});

test('a refresh is labelled session when a sign-in covers a host the registry names, none otherwise', () => {
  const grant = { 'github.com': 'gho' };
  assert.equal(tokenUse(grant, new Set(['github.com', 'elsewhere.example'])), 'session');
  assert.equal(tokenUse(grant, new Set(['elsewhere.example'])), 'none');
  assert.equal(tokenUse(grant, new Set()), 'none');
  // `constructor` is a valid host and a key every object inherits.
  assert.equal(tokenUse({}, new Set(['github.com', 'constructor'])), 'none');
});

// A repository on a host no VS Code sign-in serves stays signed out after a
// github.com sign-in, so the action names the setting that would serve it.
test('Sign in for a repository on another host opens the Enterprise setting when none names that host', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [invalid(4, 'ghe.invalid')] }] }, now);
  const results = await pollAll([repo], { now, env: noGhEnv(t), grant: {} });
  assert.deepEqual([buildModel({ results, now }).state, [...signedOutHosts(results)]], ['signed-out', ['ghe.invalid']]);
  assert.deepEqual(signInStep(signedOutHosts(results), undefined), { kind: 'configure', host: 'ghe.invalid', configured: undefined });
  assert.deepEqual(signInStep(new Set(['github.com', 'ghe.invalid']), undefined), { kind: 'configure', host: 'ghe.invalid', configured: undefined });
  assert.equal(configureMessage({ host: 'ghe.invalid', configured: undefined }), 'Epic Pulse: this repository is on ghe.invalid, and '
    + 'VS Code signs in to a GitHub Enterprise server only once `github-enterprise.uri` names it. Set it to https://ghe.invalid '
    + 'and sign in again, or run `gh auth login --hostname ghe.invalid`.');
});

test('Sign in names the mismatch when the configured Enterprise server is another host', () => {
  assert.deepEqual(signInStep(new Set(['ghe.invalid']), 'other.example'), { kind: 'configure', host: 'ghe.invalid', configured: 'other.example' });
  assert.equal(configureMessage({ host: 'ghe.invalid', configured: 'other.example' }), 'Epic Pulse: this repository is on ghe.invalid, but '
    + '`github-enterprise.uri` names other.example, the one GitHub Enterprise server VS Code signs in to. Point it at https://ghe.invalid '
    + 'and sign in again, or run `gh auth login --hostname ghe.invalid`.');
});

test('Sign in goes straight to the sign-in that serves the signed-out hosts, and asks only when two do', () => {
  const signIn = (providers: readonly string[]) => ({ kind: 'sign-in', providers });
  assert.deepEqual(signInStep(new Set(['github.com']), undefined), signIn(['github']));
  assert.deepEqual(signInStep(new Set(['github.com']), 'ghe.invalid'), signIn(['github']));
  assert.deepEqual(signInStep(new Set(['ghe.invalid']), 'ghe.invalid'), signIn(['github-enterprise']));
  assert.deepEqual(signInStep(new Set(['github.com', 'ghe.invalid']), 'ghe.invalid'), signIn(['github', 'github-enterprise']));
  // One server signs in now; the host it can not serve is named on the next click.
  assert.deepEqual(signInStep(new Set(['ghe.invalid', 'other.invalid']), 'ghe.invalid'), signIn(['github-enterprise']));
  // Run from the palette, with nothing signed out, every sign-in is offered.
  assert.deepEqual([signInStep(new Set(), undefined), signInStep(new Set(), 'ghe.invalid')], [signIn(['github']), signIn(['github', 'github-enterprise'])]);
});

test('the GitHub Enterprise host comes from a valid http(s) URI, lowercased, and is never github.com', () => {
  assert.equal(enterpriseHostOf('https://GHES.Example.com/'), 'ghes.example.com');
  assert.equal(enterpriseHostOf('https://ghes.example.com:8443/path'), 'ghes.example.com:8443');
  for (const value of ['https://github.com', 'file:///etc', 'not a url', '', undefined, 42]) {
    assert.equal(enterpriseHostOf(value), undefined, String(value));
  }
});

test('a thrown value is logged as its name and errno code, never its message', () => {
  const echoing = new TypeError(`Headers.append: "bearer ${SENTINEL}" is an invalid header value`);
  assert.equal(errorLabel(echoing), 'TypeError');
  assert.equal(errorLabel(Object.assign(new Error(SENTINEL), { code: 'ENOENT' })), 'Error ENOENT');
  assert.equal(errorLabel(Object.assign(new Error('x'), { code: SENTINEL })), 'Error');
  assert.equal(errorLabel(SENTINEL), 'string');
});
