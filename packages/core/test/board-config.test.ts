import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BOARD_FIELD, mapOption, normaliseOption, parseProject, projectFromEnv, projectToEnv, sameProject } from '../src/board-config.js';
import { parseConfig } from '../src/config.js';
import type { ProjectConfig } from '../src/schemas/board.js';

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

// An option's name is whatever a board's editors typed, and both tables are plain
// objects: `Constructor` is `constructor` once normalised, which every object
// inherits as `Object`, a function that is no status. Only an entry a table
// holds itself counts.
const INHERITED = ['constructor', 'Constructor', ' CONSTRUCTOR ', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

test('an option named for a member of Object.prototype maps to nothing, in either table', () => {
  const custom = parseProject({ ...DEMO, statusMap: { Blocked: 'todo' } })!;
  for (const name of INHERITED) {
    assert.equal(mapOption(DEMO, name), undefined, name);
    assert.equal(mapOption(custom, name), undefined, name);
  }
});

test('a status map keyed by such names, with values that are no status, keeps none of them and maps nothing', () => {
  const text = '{"owner":"takauztovies","number":3,"statusMap":{"__proto__":{"blocked":"done"},"constructor":"later","toString":7,"hasOwnProperty":null,"valueOf":"done "}}';
  const project = parseProject(JSON.parse(text) as unknown)!;
  assert.deepEqual(project.statusMap, {});
  for (const name of [...INHERITED, 'Blocked']) assert.equal(mapOption(project, name), undefined, name);
});

test('a status map keyed by such names, with a lane, maps those options as written and no other', () => {
  const text = '{"owner":"takauztovies","number":3,"statusMap":{"__proto__":"done","constructor":"in_progress","toString":"dropped","hasOwnProperty":"todo"}}';
  const project = parseProject(JSON.parse(text) as unknown)!;
  assert.equal(Object.getPrototypeOf(project.statusMap), Object.prototype);
  assert.deepEqual(['Constructor', 'toString', 'hasOwnProperty'].map((name) => mapOption(project, name)), ['in_progress', 'dropped', 'todo']);
  for (const name of ['valueOf', 'isPrototypeOf', 'propertyIsEnumerable']) assert.equal(mapOption(project, name), undefined, name);
});

// What a name reaches on the way up is not only Object.prototype's own members:
// a dependency that pollutes it hands every table an entry for any name it likes,
// and `Blocked` is read from an object that was never given it.
test('an entry inherited from a polluted Object.prototype is not an entry', () => {
  Object.defineProperty(Object.prototype, 'blocked', { value: 'done', configurable: true });
  try {
    assert.equal(mapOption(DEMO, 'Blocked'), undefined);
    assert.equal(mapOption(parseProject({ ...DEMO, statusMap: { Parked: 'todo' } })!, 'Blocked'), undefined);
  } finally {
    Reflect.deleteProperty(Object.prototype, 'blocked');
  }
  assert.equal('blocked' in {}, false, 'the prototype is as it was');
});

// The table is typed, but it is data: a block that did not come through
// parseProject may hold anything. What is not a status is not an answer, and
// the default table is asked next, as it is for an option the map does not name.
test('an entry that is no status is not an answer', () => {
  const junk = { ...DEMO, statusMap: { done: 'banana', blocked: 7 } } as unknown as ProjectConfig;
  assert.equal(mapOption(junk, 'Blocked'), undefined);
  assert.equal(mapOption(junk, 'Done'), 'done');
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
