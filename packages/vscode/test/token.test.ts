import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeRef, type IssueRef } from '@epic-pulse/core';
import { detailsText, errorLabel, outcomeLine } from '../src/details.js';
import { enterpriseHostOf, refreshEnv } from '../src/grant.js';
import { buildModel } from '../src/model.js';
import { pollAll } from '../src/poll.js';
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
    const results = await pollAll([repo], { now, env, grant: { enterprise: { host: HOST, token } } });
    assert.deepEqual([results[0]?.token, results[0]?.refresh], ['session', { status: 'done', requests: 1, points: 0, error: code }]);
    const cache = env['EPIC_PULSE_CACHE_DIR'] ?? assert.fail('no cache dir');
    const files = [...filesUnder(repo.dir), ...filesUnder(cache)];
    assert.ok(files.includes(join(repo.dir, 'snapshot.json')) && files.includes(join(cache, 'usage.jsonl')), 'nothing was written');
    for (const file of files) assert.equal(readFileSync(file, 'utf8').includes('SENTINEL'), false, file);
    const model = buildModel({ results, now });
    const details = detailsText({ results, accounts: { github: false, enterprise: HOST }, now });
    const shown = [JSON.stringify(results), JSON.stringify(treeOf(model)), JSON.stringify(statusBarOf(model)), details, ...results.map(outcomeLine)];
    for (const text of shown) assert.equal(text.includes('SENTINEL'), false, text.slice(0, 300));
  }
});

test('a token is withheld from a refresh whose registry also names a host it does not belong to', async (t) => {
  const now = Date.now();
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [invalid(4), invalid(5, 'elsewhere.invalid')] }] }, now);
  const results = await pollAll([repo], { now, env: noGhEnv(t), grant: { enterprise: { host: HOST, token: SENTINEL } } });
  // Core then found no token of its own (no variable, no gh), so no request went anywhere.
  assert.deepEqual([results[0]?.token, results[0]?.refresh], ['withheld', { status: 'done', requests: 0, points: 0, error: 'no_token' }]);
});

test('only the tokens for hosts the registry names enter the environment, and the base is left alone', () => {
  const base = Object.freeze({ PATH: '/bin', GH_TOKEN: 'from-shell' });
  const grant = { github: 'gho_session', enterprise: { host: 'ghes.example', token: 'ghes_session' } };
  const github = refreshEnv(base, grant, new Set(['github.com']));
  assert.deepEqual([github.use, github.env['GH_TOKEN'], github.env['GH_ENTERPRISE_TOKEN']], ['session', 'gho_session', undefined]);
  const both = refreshEnv(base, grant, new Set(['github.com', 'ghes.example']));
  assert.deepEqual([both.use, both.env['GH_TOKEN'], both.env['GH_ENTERPRISE_TOKEN']], ['session', 'gho_session', 'ghes_session']);
  assert.deepEqual(refreshEnv(base, grant, new Set(['github.com', 'evil.example'])), { env: base, use: 'withheld' });
  assert.deepEqual(refreshEnv(base, grant, new Set(['evil.example'])), { env: base, use: 'none' });
  assert.deepEqual(refreshEnv(base, {}, new Set(['github.com'])), { env: base, use: 'none' });
  assert.deepEqual(refreshEnv(base, grant, new Set()), { env: base, use: 'none' });
  assert.deepEqual(base, { PATH: '/bin', GH_TOKEN: 'from-shell' });
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
