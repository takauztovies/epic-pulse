// Records REAL GraphQL responses from the public demo repository into
// fixtures/graphql/. Tests parse these files; nothing in the test suite fakes a
// server. The documents come from packages/core so the fixtures are exactly what
// the product sends.
//
//   pnpm record-fixtures        (token from GH_TOKEN, GITHUB_TOKEN or `gh auth login`)
//   pnpm record-fixtures jira   (Jira Cloud demo project: see record-jira-fixtures.mjs)
//
// Only status, body and two rate-limit headers are stored. Request headers,
// including the Authorization header, never reach disk.
import { mkdir, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { postGraphql, resolveToken } from '../packages/core/src/github.ts';
import { phaseADocument, phaseBDocument } from '../packages/core/src/queries.ts';

const HOST = 'github.com';
const VARIABLES = { owner: 'takauztovies', name: 'epic-pulse' };
const MISSING = 9999;
const OUT = fileURLToPath(new URL('../fixtures/graphql/', import.meta.url));

const UNDEFINED_FIELD = `query { repository(owner: "takauztovies", name: "epic-pulse") { issue(number: 1) { noSuchField } } }`;

const RECORDINGS = [
  { name: 'phase-a', query: phaseADocument([1, 4, 8, MISSING]), note: 'sub-issue, epic, checklist epic and a missing issue' },
  { name: 'phase-b-subissues', query: phaseBDocument([1]), note: 'epic with sub-issues in every status' },
  { name: 'phase-b-checklist', query: phaseBDocument([8]), note: 'checklist-only epic' },
  { name: 'phase-b-details', query: phaseBDocument([1, 8]), note: 'both demo epics with creation, closing dates, assignee logins and bodies' },
  { name: 'phase-b-missing', query: phaseBDocument([MISSING]), note: 'issue that does not exist' },
  { name: 'error-undefined-field', query: UNDEFINED_FIELD, note: 'schema lacks a field (what an older GHES answers)' },
  { name: 'error-bad-credentials', query: phaseADocument([1]), token: 'not-a-real-token', note: 'HTTP 401' },
];

// A recording must never contain something that looks like a credential.
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;

async function record(recording, token) {
  const response = await postGraphql({
    host: HOST,
    token: recording.token ?? token,
    query: recording.query,
    variables: VARIABLES,
  });
  const document = {
    recordedAt: new Date().toISOString(),
    note: recording.note,
    status: response.status,
    remaining: response.remaining ?? null,
    retryAfter: response.retryAfter,
    body: response.body ?? null,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (TOKEN_SHAPE.test(text) || text.includes(token)) throw new Error(`${recording.name}: recording contains a credential`);
  await writeFile(`${OUT}${recording.name}.json`, text);
  return `${recording.name}: HTTP ${response.status}, ${text.length} bytes`;
}

async function main() {
  if (process.argv[2] === 'jira') {
    const { recordJira } = await import('./record-jira-fixtures.mjs');
    return recordJira(process.env);
  }
  const resolved = await resolveToken(HOST, process.env);
  if (!resolved) throw new Error('no token: set GH_TOKEN or run `gh auth login`');
  await mkdir(OUT, { recursive: true });
  // `pnpm record-fixtures phase-b-details` records only the named ones, so a
  // new recording never rewrites fixtures whose demo state has since moved on.
  const only = process.argv.slice(2);
  for (const recording of RECORDINGS.filter((r) => only.length === 0 || only.includes(r.name))) console.log(await record(recording, resolved.token));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'record-fixtures failed');
  process.exitCode = 1;
});
