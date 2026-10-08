// Records REAL Jira Cloud responses from a demo project into fixtures/jira/,
// through the same provider code the product runs, so the files are exactly
// what the parser will see. This replaces the hand-written, `unverified`
// fixtures; release.mjs --check refuses to release until it has.
//
//   JIRA_SITE=yourdemo.atlassian.net JIRA_EMAIL=you@example.com JIRA_API_TOKEN=... \
//   JIRA_DEMO_PROJECT=EPD JIRA_DEMO_EPIC=1 JIRA_DEMO_CHILD=4 pnpm record-fixtures jira
//
// The demo project: an Epic (JIRA_DEMO_EPIC) with children in every lane, one of
// them (JIRA_DEMO_CHILD) one of those children. Use a personal account that
// holds nothing else: an API token reaches every site its account can.
//
// Only status, body and the retry flag are stored. A recording is scrubbed of
// account ids, e-mail addresses, avatar links and self links before it is written,
// and refused if it still holds the credentials or anything shaped like an address.
import { mkdir, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { jiraCredentials } from '../packages/core/src/jira.ts';
import { JIRA } from '../packages/core/src/provider-jira.ts';
import { makeJiraRef } from '../packages/core/src/ref.ts';
import { scrub } from './jira-scrub.mjs';

const OUT = fileURLToPath(new URL('../fixtures/jira/', import.meta.url));
const MISSING = 9999;
const EMAIL = /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i;

function settings(env) {
  const site = (env.JIRA_SITE ?? '').trim().toLowerCase();
  const project = (env.JIRA_DEMO_PROJECT ?? 'EPD').toUpperCase();
  const [epic, child] = [Number(env.JIRA_DEMO_EPIC ?? 1), Number(env.JIRA_DEMO_CHILD ?? 4)];
  const credentials = jiraCredentials(site, env);
  if (!site || !credentials) throw new Error('set JIRA_SITE (one site), JIRA_EMAIL and JIRA_API_TOKEN');
  return { site, project, epic, child, credentials, env };
}

function recordings({ site, project, epic, child }) {
  const ref = (number) => makeJiraRef({ host: site, project, number });
  const repo = ref(epic);
  return [
    { name: 'phase-a', phase: 'A', refs: [ref(child), ref(epic), ref(MISSING)], note: 'a child, an epic with no parent, and a missing issue' },
    { name: 'phase-b-epic', phase: 'B', refs: [ref(epic)], note: 'an epic with a child in every lane' },
    { name: 'phase-b-missing', phase: 'B', refs: [ref(MISSING)], note: 'an issue that does not exist' },
  ].map((entry) => ({ ...entry, repo }));
}

async function record(entry, config) {
  const sent = await JIRA.send(config.credentials, { phase: entry.phase, repo: entry.repo, refs: entry.refs });
  if (!sent.ok) throw new Error(`${entry.name}: ${sent.error.code}`);
  const document = { recordedAt: new Date().toISOString(), note: entry.note, status: sent.value.status, remaining: null, retryAfter: sent.value.retryAfter, body: scrub(sent.value.body) };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const secrets = [config.credentials, config.env.JIRA_API_TOKEN, config.env.JIRA_EMAIL].filter(Boolean);
  if (secrets.some((secret) => text.includes(secret)) || EMAIL.test(text)) throw new Error(`${entry.name}: the recording holds a credential or an address`);
  await writeFile(`${OUT}${entry.name}.json`, text);
  return `${entry.name}: HTTP ${document.status}, ${text.length} bytes`;
}

export async function recordJira(env) {
  const config = settings(env);
  await mkdir(OUT, { recursive: true });
  for (const entry of recordings(config)) console.log(await record(entry, config));
  console.log('recorded. Check the files hold only demo data, then adjust the constants in packages/core/test/jira.test.ts (site, project) if they differ.');
}
