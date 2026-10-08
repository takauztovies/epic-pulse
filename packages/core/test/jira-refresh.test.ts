import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeJiraRef } from '../src/ref.js';
import { refresh } from '../src/refresh.js';
import { boundRegistry } from './refresh-helpers.js';
import { tempDir } from './repo-helpers.js';
import { noGhEnv } from './snapshot-helpers.js';

// The real refresher on a Jira reference. `.invalid` never resolves (RFC 6761),
// so a request that is admitted really goes out through fetch and really fails
// as `network`: the choice of provider and the credential rule are exercised
// without any stand-in for Jira.
const HOST = 'jira.invalid';
const ref = makeJiraRef({ host: HOST, project: 'EPD', number: 4 })!;
const creds = { JIRA_EMAIL: 'a@b.invalid', JIRA_API_TOKEN: 'secret' };

function env(t: Parameters<typeof noGhEnv>[0], extra: NodeJS.ProcessEnv) {
  return noGhEnv(t, { EPIC_PULSE_CACHE_DIR: tempDir(t), ...extra });
}

test('a Jira reference with no credentials is no_token, and nothing is sent', async (t) => {
  const paths = await boundRegistry(t, [ref]);
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: env(t, {}) }), { status: 'done', requests: 0, points: 0, error: 'no_token' });
});

test('credentials for the site the user named go to the Jira provider, which asks that site', async (t) => {
  const paths = await boundRegistry(t, [ref]);
  const outcome = await refresh({ dir: paths.dir, now: Date.now(), env: env(t, { ...creds, JIRA_SITE: HOST }) });
  assert.deepEqual([outcome.status, outcome.status === 'done' ? outcome.requests : -1, outcome.status === 'done' ? outcome.error : ''], ['done', 1, 'network']);
});

test('a site only the repository names never receives credentials, however they are set', async (t) => {
  const paths = await boundRegistry(t, [ref]);
  for (const JIRA_SITE of [undefined, 'acme.atlassian.net', 'x' + HOST]) {
    const outcome = await refresh({ dir: paths.dir, now: Date.now(), env: env(t, { ...creds, ...(JIRA_SITE ? { JIRA_SITE } : {}) }) });
    assert.deepEqual(outcome, { status: 'done', requests: 0, points: 0, error: 'no_token' }, String(JIRA_SITE));
  }
});

test('a GitHub token is never offered to a Jira site, and a Jira credential never to GitHub', async (t) => {
  const paths = await boundRegistry(t, [ref]);
  const onlyGithub = env(t, { GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_x', GH_ENTERPRISE_TOKEN: 'x', EPIC_PULSE_HOSTS: HOST });
  assert.deepEqual(await refresh({ dir: paths.dir, now: Date.now(), env: onlyGithub }), { status: 'done', requests: 0, points: 0, error: 'no_token' });
});
