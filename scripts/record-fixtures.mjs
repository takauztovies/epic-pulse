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
import { boardDocument } from '../packages/core/src/board-query.ts';

const HOST = 'github.com';
const VARIABLES = { owner: 'takauztovies', name: 'epic-pulse' };
const MISSING = 9999;
const OUT = fileURLToPath(new URL('../fixtures/graphql/', import.meta.url));

// The demo board, https://github.com/users/takauztovies/projects/3, linked to
// the demo repository: #4 Done, #5 Todo, #6 In Progress.
const BOARD = { owner: 'takauztovies', field: 'Status' };
const BOARD_NUMBER = 3;
// A token WITHOUT the `project` scope, for the one recording that has to show
// GitHub refusing the board (any account's: the demo board is public).
const NO_PROJECT_TOKEN = 'EPIC_PULSE_NO_PROJECT_TOKEN';

const UNDEFINED_FIELD = `query { repository(owner: "takauztovies", name: "epic-pulse") { issue(number: 1) { noSuchField } } }`;

const RECORDINGS = [
  { name: 'phase-a', query: phaseADocument([1, 4, 8, MISSING]), note: 'sub-issue, epic, checklist epic and a missing issue' },
  { name: 'phase-b-subissues', query: phaseBDocument([1]), note: 'epic with sub-issues in every status' },
  { name: 'phase-b-checklist', query: phaseBDocument([8]), note: 'checklist-only epic' },
  { name: 'phase-b-details', query: phaseBDocument([1, 8]), note: 'both demo epics with creation, closing dates, assignee logins and bodies' },
  { name: 'phase-b-nested-43', query: phaseBDocument([43]), note: 'program epic whose sub-issue #44 has sub-issues of its own' },
  { name: 'phase-b-nested-44', query: phaseBDocument([44]), note: 'sub-epic A: a sub-epic (#45) and a closed task (#47)' },
  { name: 'phase-b-nested-45', query: phaseBDocument([45]), note: 'sub-epic B, the deepest: one leaf (#48)' },
  { name: 'phase-b-missing', query: phaseBDocument([MISSING]), note: 'issue that does not exist' },
  { name: 'error-undefined-field', query: UNDEFINED_FIELD, note: 'schema lacks a field (what an older GHES answers)' },
  { name: 'error-bad-credentials', query: phaseADocument([1]), token: 'not-a-real-token', note: 'HTTP 401' },
  { name: 'phase-b-board', query: phaseBDocument([1]), note: 'demo epic #1 next to the board recordings: #4 closed since the older ones' },
  { name: 'board-demo', query: boardDocument(BOARD_NUMBER), variables: BOARD, note: 'demo project board, one page: #4 Done, #5 Todo, #6 In Progress' },
  { name: 'board-paged', query: boardDocument(BOARD_NUMBER, 1), variables: BOARD, note: 'the first page of the demo board one item at a time: there are more' },
  { name: 'board-not-found', query: boardDocument(99), variables: BOARD, note: 'a project number the owner does not have' },
  { name: 'board-no-scope', query: boardDocument(BOARD_NUMBER), variables: BOARD, tokenEnv: NO_PROJECT_TOKEN, note: 'token without read:project' },
];

// A recording must never contain something that looks like a credential.
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;

async function record(recording, token) {
  const own = recording.tokenEnv === undefined ? recording.token : process.env[recording.tokenEnv];
  if (recording.tokenEnv !== undefined && !own) return `${recording.name}: skipped, set ${recording.tokenEnv} to a token without the project scope`;
  const response = await postGraphql({
    host: HOST,
    token: own ?? token,
    query: recording.query,
    variables: recording.variables ?? VARIABLES,
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
  if (TOKEN_SHAPE.test(text) || text.includes(token) || (own && text.includes(own))) throw new Error(`${recording.name}: recording contains a credential`);
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
