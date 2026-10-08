import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfText } from '../src/jira-adf.js';
import { parseJira } from '../src/jira-config.js';
import { epicAnswers, resolutionAnswers } from '../src/jira-epic.js';
import { jiraKeysIn } from '../src/jira-keys.js';
import { deriveJiraStatus } from '../src/jira-status.js';
import { jiraCredentials, jiraSites } from '../src/jira.js';
import { displayKey, issueUrl, makeJiraRef, makeRef, parseIssueTarget, refKey, repoKey } from '../src/ref.js';
import { applyBuiltEpics, applyResolutions } from '../src/refresh-apply.js';
import { JiraPhaseASchema, JiraPhaseBSchema } from '../src/schemas/jira.js';
import { emptySnapshot } from '../src/snapshot.js';
import { buildView } from '../src/view.js';
import { loadJiraFixture } from './helpers.js';

const HOST = 'epic-pulse-demo.atlassian.net';
const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const config = parseJira({ site: HOST, projects: ['EPD'] })!;
const epd = (number: number) => makeJiraRef({ host: HOST, project: 'EPD', number })!;

test('a Jira reference is its own key, never a GitHub one, and a GitHub reference is untouched', () => {
  const jira = epd(12);
  assert.deepEqual([displayKey(jira), refKey(jira), repoKey(jira), issueUrl(jira)], ['EPD-12', `jira:${HOST}/epd-12`, `jira:${HOST}/epd`, `https://${HOST}/browse/EPD-12`]);
  assert.equal(makeJiraRef({ host: HOST, project: 'epd', number: 12 })?.owner, 'epd', 'a key is stored lowercase, shown in capitals');
  const github = makeRef({ host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12 })!;
  assert.deepEqual([refKey(github), displayKey(github), 'kind' in github], ['github.com/acme/widgets#12', '#12', false]);
});

test('a key or a /browse/ URL is a Jira target, and nothing else is mistaken for one', () => {
  assert.deepEqual(parseIssueTarget('EPD-12'), { number: 12, jira: { project: 'EPD' } });
  assert.deepEqual(parseIssueTarget(`https://${HOST}/browse/epd-12?x=1`), { number: 12, jira: { host: HOST, project: 'epd' } });
  assert.deepEqual(parseIssueTarget('#12'), { number: 12 });
  for (const text of ['UTF-8x', 'E-1', 'TOOLONGPROJECT-1', 'EPD-', '-12', 'EPD-12abc']) assert.equal(parseIssueTarget(text), undefined, text);
});

test('keys are found only for the configured projects, and only as whole keys', () => {
  const found = (text: string) => jiraKeysIn(text, config).map(displayKey);
  assert.deepEqual(found('feature/EPD-12-login'), ['EPD-12']);
  assert.deepEqual(found('fix epd-7 and EPD-8, again EPD-7'), ['EPD-7', 'EPD-8']);
  assert.deepEqual(found('UTF-8, SHA-256, ISO-9660, XEPD-1, EPD-1x, EPD-1234567890'), [], 'other prefixes, a longer word, a number too long');
});

test('the jira block keeps what is valid and drops the rest, and needs a site and a project', () => {
  assert.equal(parseJira({ site: 'not a host', projects: ['EPD'] }), undefined);
  assert.equal(parseJira({ site: HOST, projects: ['nope-1', 7] }), undefined);
  const parsed = parseJira({ site: ` ${HOST.toUpperCase()} `, projects: ['epd', 'EPD', 'OPS'], statusMap: { ' In QA ': 'in_review', Odd: 'sideways' }, droppedResolutions: ["Won't Do"] })!;
  assert.deepEqual([parsed.site, parsed.projects, parsed.statusMap, parsed.droppedResolutions], [HOST, ['EPD', 'OPS'], { 'in qa': 'in_review' }, ["won't do"]]);
});

test('status comes from the category, with the repository\'s own map on top', () => {
  const lane = (statusName: string, categoryKey: string, resolution?: string) => deriveJiraStatus({ statusName, categoryKey, resolution }, parseJira({ site: HOST, projects: ['EPD'], statusMap: { 'ready for qa': 'in_review' } }));
  assert.deepEqual(
    [lane('To Do', 'new'), lane('In Progress', 'indeterminate'), lane('Code Review', 'indeterminate'), lane('Ready for QA', 'new'), lane('Done', 'done', 'Done'), lane('Closed', 'done', "Won't Do"), lane('Done', 'done'), lane('Weird', 'undefined')],
    ['todo', 'in_progress', 'in_review', 'in_review', 'done', 'dropped', 'done', 'todo'],
  );
});

test('a description in Atlassian Document Format reads as its text, and code is left out', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Goal' }] }, { type: 'codeBlock', content: [{ type: 'text', text: 'rm -rf /' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'done.' }] }] };
  assert.equal(adfText(doc).replace(/\s+/g, ' ').trim(), 'Goal done.');
  assert.equal(adfText(null), '');
  assert.equal(adfText('plain text from v2'), 'plain text from v2');
  let deep: unknown = { type: 'text', text: 'x' };
  for (let i = 0; i < 5000; i += 1) deep = { type: 'blockquote', content: [deep] };
  assert.doesNotThrow(() => adfText(deep));
});

// 100,000 tiny nodes took 14 seconds when the output was re-measured at every
// node; found by the commit security review. The walk is now bounded by the
// nodes it visits as well as the characters it keeps.
test('a description built from very many tiny nodes can not stall a refresh', () => {
  const paragraph = (count: number, text: string) => ({ type: 'paragraph', content: Array.from({ length: count }, () => ({ type: 'text', text })) });
  const documents = [
    { type: 'doc', content: [paragraph(100_000, '')] },
    { type: 'doc', content: [paragraph(300_000, 'a')] },
    { type: 'doc', content: Array.from({ length: 100_000 }, () => ({ type: 'rule' })) },
  ];
  const started = performance.now();
  const lengths = documents.map((doc) => adfText(doc).length);
  assert.ok(performance.now() - started < 300, `${Math.round(performance.now() - started)} ms for ${documents.length} hostile descriptions`);
  assert.deepEqual(lengths.map((length) => length <= 4000), [true, true, true]);
  assert.equal(adfText({ type: 'doc', content: [paragraph(10, 'ab')] }).startsWith('ababab'), true, 'an ordinary description is read whole');
});

// Credentials go only to a site the user named in their own environment: an
// Atlassian token works on every site its account reaches, and a repository's
// .epic-pulse.json (untrusted) names the site the keys belong to.
test('credentials are offered only to a site the user named in JIRA_SITE', () => {
  const env = { JIRA_SITE: `https://${HOST}/, other.example.com`, JIRA_EMAIL: 'a@b.invalid', JIRA_API_TOKEN: 'secret' };
  assert.deepEqual([...jiraSites(env)], [HOST, 'other.example.com']);
  assert.equal(jiraCredentials(HOST, env), Buffer.from('a@b.invalid:secret').toString('base64'));
  assert.equal(jiraCredentials(HOST.toUpperCase(), env) !== undefined, true);
  assert.equal(jiraCredentials('evil.atlassian.net', env), undefined, 'a site only a repository names');
  assert.equal(jiraCredentials(HOST, { ...env, JIRA_SITE: undefined }), undefined);
  assert.equal(jiraCredentials(HOST, { ...env, JIRA_API_TOKEN: ' ' }), undefined);
  assert.equal(jiraCredentials(HOST, { JIRA_SITE: HOST }), undefined);
});

// UNVERIFIED fixtures: hand-written from the REST v3 documentation until
// `pnpm record-fixtures jira` replaces them (release.mjs --check refuses to ship them).
test('an issue resolves to its parent, an issue without one to itself, and a missing one to nothing', () => {
  const parsed = JiraPhaseASchema.parse(loadJiraFixture('phase-a').body);
  const answers = resolutionAnswers([epd(4), epd(1), epd(9999)], parsed);
  const snapshot = applyResolutions(emptySnapshot(T0), answers, T0);
  assert.deepEqual(
    [4, 1, 9999].map((n) => snapshot.issues[refKey(epd(n))]?.epic ? refKey(snapshot.issues[refKey(epd(n))]!.epic!) : null),
    [refKey(epd(1)), refKey(epd(1)), null],
  );
});

test('an epic from Jira becomes the same snapshot and view a GitHub epic does, with Jira keys', () => {
  const data = JiraPhaseBSchema.parse(loadJiraFixture('phase-b-epic').body);
  const built = epicAnswers([epd(1)], data, config);
  const snapshot = applyBuiltEpics(emptySnapshot(T0), built, T0);
  const entry = snapshot.epics[refKey(epd(1))]!;
  assert.deepEqual(entry.children.map((child) => [child.key, child.status]), [
    ['EPD-2', 'done'], ['EPD-3', 'dropped'], ['EPD-4', 'in_progress'], ['EPD-5', 'in_review'], ['EPD-6', 'todo'], ['EPD-7', 'todo'],
  ]);
  assert.equal(entry.summary, 'Public demo epic used by epic-pulse fixtures and live tests. Children cover every derived status.');
  assert.deepEqual([entry.createdAt, entry.children[0]?.closedAt, entry.children[2]?.assignees, entry.children[2]?.labels], [Date.parse('2026-09-30T13:13:05.000+0000'), Date.parse('2026-09-30T13:13:28.000+0000'), ['Ana Example'], ['frontend']]);
  const view = buildView({ snapshot: { status: 'ok', snapshot }, sessions: [], pins: [{ ref: epd(1), addedAt: 0 }], now: T0 }).epics[0]!;
  assert.deepEqual([view.key, view.url, view.percent, view.counts.dropped, view.children[2]?.key], ['EPD-1', `https://${HOST}/browse/EPD-1`, 20, 1, 'EPD-4']);
});

test('an epic that is not found, or has no children, is not an epic', () => {
  const missing = JiraPhaseBSchema.parse(loadJiraFixture('phase-b-missing').body);
  assert.deepEqual(epicAnswers([epd(5)], missing, config).map(([, data]) => data), [null]);
  const empty = JiraPhaseBSchema.parse({ epics: { issues: [{ key: 'EPD-5', fields: { summary: 'Lonely' } }] }, children: { 'EPD-5': { issues: [], complete: true } } });
  assert.deepEqual(epicAnswers([epd(5)], empty, config).map(([, data]) => data), [null]);
});
