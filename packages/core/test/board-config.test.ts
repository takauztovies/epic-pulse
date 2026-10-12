import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BOARD_FIELD, mapOption, normaliseOption, parseProject, projectFromEnv, projectToEnv, sameProject } from '../src/board-config.js';
import { parseConfig } from '../src/config.js';

const DEMO = { owner: 'takauztovies', number: 3, field: 'Status', statusMap: {} };

test('a project block with an owner and a number is a board; the field defaults to Status', () => {
  assert.deepEqual(parseProject({ owner: 'TakaUztovies', number: 3 }), { ...DEMO, field: DEFAULT_BOARD_FIELD });
  assert.deepEqual(parseConfig({ project: { owner: 'takauztovies', number: 3, field: 'Stage' } }).project, { ...DEMO, field: 'Stage' });
});

test('no owner or no number is no board, and the rest of the file still counts', () => {
  assert.equal(parseProject({ number: 3 }), undefined);
  assert.equal(parseProject({ owner: 'takauztovies' }), undefined);
  assert.equal(parseProject({ owner: 'takauztovies', number: -1 }), undefined);
  assert.equal(parseProject('takauztovies/3'), undefined);
  const config = parseConfig({ project: { owner: 'bad owner!', number: 3 }, ignoreMainCheckout: true });
  assert.equal(config.project, undefined);
  assert.equal(config.ignoreMainCheckout, true);
  assert.equal('project' in parseConfig({}), false);
});

test('a bad field or status map falls back on its own, without voiding the block', () => {
  assert.deepEqual(parseProject({ owner: 'takauztovies', number: 3, field: 42, statusMap: 'x' }), DEMO);
  assert.deepEqual(parseProject({ owner: 'takauztovies', number: 3, field: '   ' }), DEMO);
  const project = parseProject({ owner: 'takauztovies', number: 3, statusMap: { '🚧 Blocked': 'in_progress', Parked: 'later', '!!!': 'todo' } });
  assert.deepEqual(project?.statusMap, { blocked: 'in_progress' });
});

test('option names are normalised: lowercased, everything but letters and digits removed', () => {
  assert.equal(normaliseOption('In Progress'), 'inprogress');
  assert.equal(normaliseOption("Won't do"), 'wontdo');
  assert.equal(normaliseOption('🚧 in-review'), 'inreview');
  assert.equal(normaliseOption('Prüfung 2'), 'prüfung2');
});

test('the default table maps the common lanes, and the status map overrides it', () => {
  const lanes = ['Todo', 'Backlog', 'Ready', 'In Progress', 'Doing', 'WIP', 'In Review', 'Review', 'QA', 'Testing', 'Done', 'Complete', 'Shipped', "Won't do", 'Dropped', 'Cancelled', 'Not planned'];
  assert.deepEqual(lanes.map((name) => mapOption(DEMO, name)), [
    'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'in_progress', 'in_review', 'in_review', 'in_review', 'in_review', 'done', 'done', 'done', 'dropped', 'dropped', 'dropped', 'dropped',
  ]);
  assert.equal(mapOption(DEMO, 'Blocked'), undefined);
  const custom = parseProject({ ...DEMO, statusMap: { 'Ready': 'in_progress', Blocked: 'in_progress' } })!;
  assert.equal(mapOption(custom, 'ready'), 'in_progress');
  assert.equal(mapOption(custom, 'BLOCKED'), 'in_progress');
  assert.equal(mapOption(custom, 'Done'), 'done');
});

test('the block survives the hand-over to a detached refresh, and is checked again there', () => {
  const project = parseProject({ ...DEMO, statusMap: { Blocked: 'todo' } });
  assert.deepEqual(projectFromEnv(projectToEnv(project)), project);
  assert.deepEqual(projectToEnv(undefined), {});
  assert.equal(projectFromEnv({ EPIC_PULSE_PROJECT: '{"owner":"a b","number":3}' }), undefined);
  assert.equal(projectFromEnv({ EPIC_PULSE_PROJECT: 'not json' }), undefined);
});

test('the same block is the same board whatever order the overrides were written in', () => {
  const a = parseProject({ ...DEMO, statusMap: { Blocked: 'todo', Parked: 'dropped' } })!;
  const b = parseProject({ ...DEMO, statusMap: { Parked: 'dropped', Blocked: 'todo' } })!;
  assert.equal(sameProject(a, b), true);
  assert.equal(sameProject(a, { ...a, number: 4 }), false);
  assert.equal(sameProject(a, { ...a, statusMap: {} }), false);
});
