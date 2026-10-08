import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.js';
import { assertAbsent, buildHookOnly, declaredFunctions, importsOf, isNetworkModule, mentions, shippedBundle } from './privacy-bundle.js';

// The README promises that the hook never touches the network and that the
// only things epic-pulse sends anywhere are a GraphQL read to GitHub and, for a
// repository that declares Jira, a read-only search to the Jira site the user
// named in JIRA_SITE. These tests hold the shipped code to that.

const GITHUB_CLIENT = join(ROOT, 'packages', 'core', 'src', 'github.ts');
const JIRA_CLIENT = join(ROOT, 'packages', 'core', 'src', 'jira.ts');

// The modules that plan, send and charge requests to GitHub.
const REFRESHER = [
  'packages/core/src/refresh.ts',
  'packages/core/src/refresh-batch.ts',
  'packages/core/src/queries.ts',
  'packages/core/src/provider-jira.ts',
  'packages/core/src/usage-ledger.ts',
  'packages/cli/src/refresh-spawn.ts',
];

// Every address the bundle may spell out, with the reason it is there. Only
// the first three (through apiUrl(host)) and the Jira search are ever requested.
const ALLOWED_URLS: ReadonlyMap<string, string> = new Map([
  ['https://api.github.com/graphql', 'GraphQL on github.com, the only host a github.com token is sent to'],
  ['https://api.${host}/graphql', 'GraphQL on GitHub Enterprise Cloud with data residency (<name>.ghe.com)'],
  ['https://${host}/api/graphql', 'GraphQL on GitHub Enterprise Server'],
  ['https://${options.host}${SEARCH_PATH}', 'the Jira search, read only, requested only with credentials for a site named in JIRA_SITE'],
  ['https://${ref.host}/${ref.owner}/${ref.repo}/issues/${ref.number}', 'an issue link to show, never fetched'],
  ['https://${ref.host}/browse/${displayKey(ref)}', 'a Jira issue link to show, never fetched'],
  ['http://[${value}]', "zod's IPv6 check hands this to URL.canParse, never fetched"],
  ['https://json-schema.org/draft/2020-12/schema', 'a JSON Schema dialect id inside zod, never fetched'],
  ['http://json-schema.org/draft-07/schema#', 'a JSON Schema dialect id inside zod, never fetched'],
  ['http://json-schema.org/draft-04/schema#', 'a JSON Schema dialect id inside zod, never fetched'],
]);
// Links to this project's own pages may appear in messages.
const PROJECT = 'https://github.com/takauztovies/epic-pulse';

function isProjectLink(url: string): boolean {
  return url === PROJECT || url.startsWith(`${PROJECT}/`) || url.startsWith(`${PROJECT}#`);
}

test('the hook-only build is the real hook path and holds no refresher module', async () => {
  const hook = await buildHookOnly();
  for (const module of ['packages/cli/src/hook.ts', 'packages/core/src/extract.ts', 'packages/core/src/registry.ts']) {
    assert.ok((hook.contributions.get(module) ?? 0) > 0, `${module} is missing from the hook-only build, so it checks nothing`);
  }
  assert.deepEqual(REFRESHER.filter((module) => (hook.contributions.get(module) ?? 0) > 0), []);
});

// github.ts itself is in the hook's graph (core is one barrel) and keeps its
// module-level constants there, but none of its functions: no request, no
// token lookup, no `gh auth token`.
test('the hook path reaches no network code: no fetch, no GitHub client function, no socket module', async () => {
  const hook = await buildHookOnly();
  const client = declaredFunctions(GITHUB_CLIENT);
  assert.ok(client.includes('postGraphql') && client.includes('resolveToken'), 'github.ts no longer declares what this test looks for');
  assert.deepEqual(client.filter((name) => mentions(hook.text, name)), []);
  const jira = declaredFunctions(JIRA_CLIENT);
  assert.ok(jira.includes('searchJira') && jira.includes('jiraCredentials'), 'jira.ts no longer declares what this test looks for');
  assert.deepEqual(jira.filter((name) => mentions(hook.text, name)), [], 'the hook path reaches the Jira client');
  assertAbsent(hook.text, /\bfetch\s*\(/, 'the hook-only build');
  assert.deepEqual(hook.imports.filter(isNetworkModule), []);
});

test('every address in the shipped bundle is on the allowlist', () => {
  const urls = [...new Set(shippedBundle().match(/https?:\/\/[^\s"'`]*/g) ?? [])];
  assert.ok(urls.includes('https://api.github.com/graphql'), 'the scan found no GitHub endpoint, so it is not reading the bundle');
  assert.deepEqual(urls.filter((url) => !ALLOWED_URLS.has(url) && !isProjectLink(url)), []);
});

test('the shipped bundle makes two network calls, the GraphQL POST to apiUrl(host) and the Jira search, and opens no socket itself', () => {
  const text = shippedBundle();
  const calls = [...text.matchAll(/\bfetch\s*\(/g)].map((match) => text.slice(match.index ?? 0).split(',')[0]);
  assert.deepEqual([...calls].sort(), ['fetch(`https://${options.host}${SEARCH_PATH}`', 'fetch(apiUrl(options.host)']);
  assert.deepEqual(importsOf(text).filter(isNetworkModule), []);
  assertAbsent(text, /\b(?:WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/, 'the bundle');
});
