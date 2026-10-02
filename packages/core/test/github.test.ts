import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { apiUrl, describeFetchError, ghChildEnv, postGraphql, resolveToken } from '../src/github.js';

// An empty directory as PATH makes `gh` unfindable, so only env vars can answer.
async function withNoGh<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ep-nogh-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('github.com reads GH_TOKEN before GITHUB_TOKEN and trims it', async () => {
  await withNoGh(async (PATH) => {
    const both = await resolveToken('github.com', { PATH, GH_TOKEN: ' first\n', GITHUB_TOKEN: 'second' });
    assert.deepEqual(both, { token: 'first', source: 'GH_TOKEN' });
    const only = await resolveToken('github.com', { PATH, GH_TOKEN: '  ', GITHUB_TOKEN: 'second' });
    assert.deepEqual(only, { token: 'second', source: 'GITHUB_TOKEN' });
    assert.equal(await resolveToken('github.com', { PATH }), undefined);
  });
});

test('a github.com token is never offered to another host, not even one the user named', async () => {
  await withNoGh(async (PATH) => {
    const env = { PATH, GH_TOKEN: 'dotcom-secret', GITHUB_TOKEN: 'dotcom-secret', GH_HOST: 'ghe.example.com' };
    assert.equal(await resolveToken('ghe.example.com', env), undefined);
    const enterprise = await resolveToken('ghe.example.com', { ...env, GH_ENTERPRISE_TOKEN: 'ghes-secret' });
    assert.deepEqual(enterprise, { token: 'ghes-secret', source: 'GH_ENTERPRISE_TOKEN' });
  });
});

// The host comes from repository data (a remote, `gh -R`, an issue URL), which
// a hostile checkout controls. gh ties the Enterprise variables to no host, so
// they go only to a host the user named.
test('the Enterprise variables go to no host the user has not named in GH_HOST or EPIC_PULSE_HOSTS', async () => {
  await withNoGh(async (PATH) => {
    const secret = { PATH, GH_ENTERPRISE_TOKEN: 'ghes-secret', GITHUB_ENTERPRISE_TOKEN: 'ghes-secret' };
    for (const named of [{}, { GH_HOST: 'ghe.example.com' }, { EPIC_PULSE_HOSTS: 'ghe.example.com,other.example' }]) {
      assert.equal(await resolveToken('untrusted.example', { ...secret, ...named }), undefined, JSON.stringify(named));
    }
    // Exact hosts only: no suffix, prefix or other port of a named host is that host.
    const named = { ...secret, EPIC_PULSE_HOSTS: 'ghe.example.com', GH_HOST: 'other.example' };
    for (const host of ['evil-ghe.example.com', 'ghe.example.com.evil.example', 'example.com', 'ghe.example.com:8443', 'acme.ghe.com']) {
      assert.equal(await resolveToken(host, named), undefined, host);
    }
  });
});

test('GH_HOST, or an entry of EPIC_PULSE_HOSTS, trusts its host however it is spaced or cased', async () => {
  await withNoGh(async (PATH) => {
    const enterprise = { token: 'ghes-secret', source: 'GH_ENTERPRISE_TOKEN' };
    const env = { PATH, GH_ENTERPRISE_TOKEN: 'ghes-secret' };
    assert.deepEqual(await resolveToken('ghe.example.com', { ...env, GH_HOST: ' GHE.Example.com ' }), enterprise);
    const listed = { ...env, EPIC_PULSE_HOSTS: 'not a host,, other.example ,GHE.example.com:8443' };
    assert.deepEqual(await resolveToken('ghe.example.com:8443', listed), enterprise);
    assert.deepEqual(await resolveToken('other.example', listed), enterprise);
    const second = await resolveToken('other.example', { PATH, GITHUB_ENTERPRISE_TOKEN: 'second', EPIC_PULSE_HOSTS: 'other.example' });
    assert.deepEqual(second, { token: 'second', source: 'GITHUB_ENTERPRISE_TOKEN' });
  });
});

// The real gh from this machine's PATH, with a config directory of its own
// that holds one login, for ghe.example.com. Skipped where gh is missing;
// GitHub's runners all have it.
const GH_DIR = (process.env['PATH'] ?? '').split(delimiter).find((dir) => dir !== '' && existsSync(join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh')));
const HOSTS_YML = 'ghe.example.com:\n    users:\n        someone:\n            oauth_token: gh-login-token\n    git_protocol: https\n    user: someone\n    oauth_token: gh-login-token\n';

async function withGhLogin(run: (env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'ep-gh-'));
  try {
    await writeFile(join(home, 'hosts.yml'), HOSTS_YML);
    const system = process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] };
    await run({ PATH: GH_DIR, HOME: home, USERPROFILE: home, GH_CONFIG_DIR: home, GH_NO_UPDATE_NOTIFIER: '1', ...system });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// gh prefers these variables to its own logins: GH_ENTERPRISE_TOKEN for any
// host, GH_TOKEN for *.ghe.com. Left in its environment, gh would hand one to
// a host resolveToken has just refused it.
test('gh is asked without the token variables, so it answers only with its own logins', { skip: GH_DIR === undefined && 'needs gh on the PATH' }, async () => {
  await withGhLogin(async (env) => {
    const secret = 'env-secret';
    const leaked = { ...env, GH_TOKEN: secret, GITHUB_TOKEN: secret, GH_ENTERPRISE_TOKEN: secret, GITHUB_ENTERPRISE_TOKEN: secret };
    assert.deepEqual(await resolveToken('ghe.example.com', leaked), { token: 'gh-login-token', source: 'gh-cli' });
    assert.equal(await resolveToken('untrusted.example', leaked), undefined);
    assert.equal(await resolveToken('acme.ghe.com', leaked), undefined);
  });
});

test('gh gets the whole environment but the four token variables, whatever their case', () => {
  const env = Object.freeze({ PATH: '/bin', GH_HOST: 'ghe.example.com', GH_TOKEN: 'a', gh_token: 'b', GitHub_Token: 'c', GH_ENTERPRISE_TOKEN: 'd',
    github_enterprise_token: 'e', GH_TOKEN_FILE: 'kept' });
  assert.deepEqual(ghChildEnv(env), { PATH: '/bin', GH_HOST: 'ghe.example.com', GH_TOKEN_FILE: 'kept', GH_PROMPT_DISABLED: '1' });
});

test('a host that is not a plain hostname never reaches the gh command line', async () => {
  assert.equal(await resolveToken('--help', { GH_TOKEN: 'x' }), undefined);
  assert.equal(await resolveToken('a b', { GH_TOKEN: 'x' }), undefined);
});

test('API endpoint per host flavour', () => {
  assert.equal(apiUrl('github.com'), 'https://api.github.com/graphql');
  assert.equal(apiUrl('ghe.example.com'), 'https://ghe.example.com/api/graphql');
  assert.equal(apiUrl('acme.ghe.com'), 'https://api.acme.ghe.com/graphql');
});

test('a failed request maps to a code plus an errno name, not to the library message', async () => {
  // .invalid never resolves (RFC 6761): a real request, real DNS failure, no server.
  const failure = await postGraphql({ host: 'epic-pulse.invalid', token: 't', query: 'query { x }', variables: {}, timeoutMs: 5000 }).then(
    () => undefined,
    (error: unknown) => describeFetchError(error),
  );
  assert.equal(failure?.code, 'network');
  assert.match(failure?.detail ?? '', /^[A-Z][A-Z0-9_]{2,40}$/);
});

test('a malformed token is reported as invalid_token without echoing it', async () => {
  // undici puts the whole header value into its TypeError message.
  const secret = 'SENTINEL\u0000TOKEN';
  const failure = await postGraphql({ host: 'epic-pulse.invalid', token: secret, query: 'query { x }', variables: {}, timeoutMs: 5000 }).then(
    () => undefined,
    (error: unknown) => describeFetchError(error),
  );
  assert.equal(failure?.code, 'invalid_token');
  assert.ok(!JSON.stringify(failure).includes('SENTINEL'));
});

test('timeouts are recognised by error name', () => {
  assert.equal(describeFetchError(new DOMException('slow', 'TimeoutError')).code, 'timeout');
  assert.equal(describeFetchError('not an error object').code, 'network');
});
