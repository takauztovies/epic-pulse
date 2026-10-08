import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bash, fileTool, signals, widgetsRepo, writeConfig } from './extract-helpers.js';
import { addWorktree } from './repo-helpers.js';

const SITE = 'acme.atlassian.net';
const EPD12 = `jira:${SITE}/epd-12`;

// A worktree on `feature/EPD-12-login` of a repository whose origin is GitHub.
function jiraRepo(t: Parameters<typeof widgetsRepo>[0], config: unknown) {
  const { repo } = widgetsRepo(t);
  const wt = addWorktree(repo, 'wt-epd', 'feature/EPD-12-login');
  if (config !== undefined) writeConfig(wt, config);
  return wt;
}

const declared = { jira: { site: SITE, projects: ['EPD'] } };

test('an edit in a worktree whose branch carries a configured Jira key binds it via the branch', async (t) => {
  const wt = jiraRepo(t, declared);
  assert.deepEqual(await signals(fileTool('Edit', join(wt, 'src', 'a.ts'))), [`branch:${EPD12}`]);
});

test('without a jira block, or for another project, a Jira-looking branch binds nothing', async (t) => {
  assert.deepEqual(await signals(fileTool('Edit', join(jiraRepo(t, undefined), 'a.ts'))), []);
  assert.deepEqual(await signals(fileTool('Edit', join(jiraRepo(t, { jira: { site: SITE, projects: ['OPS'] } }), 'a.ts'))), []);
});

test('a commit message that names a configured key binds it, and UTF-8 or SHA-256 do not', async (t) => {
  const wt = jiraRepo(t, declared);
  assert.deepEqual(await signals(bash('git commit -m "EPD-12 add the login form"', wt)), [`closing:${EPD12}`]);
  assert.deepEqual(await signals(bash('git commit -m "handle UTF-8 and SHA-256 in the importer"', wt)), []);
});

test('epic-pulse track pins a Jira key to the declared site, or to the site its URL names, and needs one', async (t) => {
  const wt = jiraRepo(t, declared);
  assert.deepEqual(await signals(bash('epic-pulse track EPD-12', wt)), [`pin:${EPD12}`]);
  assert.deepEqual(await signals(bash(`epic-pulse track https://other.atlassian.net/browse/EPD-12`, wt)), ['pin:jira:other.atlassian.net/epd-12']);
  assert.deepEqual(await signals(bash('epic-pulse untrack EPD-12', wt)), [`-${EPD12}`]);
  assert.deepEqual(await signals(bash('epic-pulse track EPD-12', jiraRepo(t, undefined))), [], 'no site to put it on');
});

test('a branch with both a Jira key and a leading GitHub number binds the Jira key', async (t) => {
  const { repo } = widgetsRepo(t);
  const wt = addWorktree(repo, 'wt-both', '7-EPD-12-login');
  writeConfig(wt, declared);
  assert.deepEqual(await signals(fileTool('Edit', join(wt, 'a.ts'))), [`branch:${EPD12}`]);
});
