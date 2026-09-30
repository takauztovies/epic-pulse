import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiUrl, describeFetchError, postGraphql, resolveToken } from '../src/github.js';

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

test('a github.com token is never offered to another host', async () => {
  await withNoGh(async (PATH) => {
    const env = { PATH, GH_TOKEN: 'dotcom-secret', GITHUB_TOKEN: 'dotcom-secret' };
    assert.equal(await resolveToken('ghe.example.com', env), undefined);
    const enterprise = await resolveToken('ghe.example.com', { ...env, GH_ENTERPRISE_TOKEN: 'ghes-secret' });
    assert.deepEqual(enterprise, { token: 'ghes-secret', source: 'GH_ENTERPRISE_TOKEN' });
  });
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
