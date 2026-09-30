import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checklistChildren, parseChecklist } from '../src/checklist.js';
import { makeRef } from '../src/ref.js';
import { loadFixture } from './helpers.js';

const EPIC = makeRef({ host: 'github.com', owner: 'acme', repo: 'widgets', number: 1 })!;

test('checked, unchecked and struck items map to done, todo and dropped', () => {
  const items = parseChecklist('- [x] a\n- [ ] b\n- [ ] ~~c~~');
  assert.deepEqual(
    items.map((i) => [i.text, i.checked, i.struck]),
    [['a', true, false], ['b', false, false], ['~~c~~', false, true]],
  );
  assert.deepEqual(
    checklistChildren('- [x] a\n- [ ] b\n- [ ] ~~c~~', EPIC).map((c) => c.status),
    ['done', 'todo', 'dropped'],
  );
});

test('a struck item is dropped even when its box is checked', () => {
  assert.equal(checklistChildren('- [x] ~~old idea~~', EPIC)[0]?.status, 'dropped');
});

test('a partly struck item is ordinary text, not dropped', () => {
  assert.equal(checklistChildren('- [ ] ~~old~~ and ~~older~~ idea', EPIC)[0]?.status, 'todo');
  assert.equal(checklistChildren('- [ ] keep ~~this~~ one', EPIC)[0]?.status, 'todo');
});

test('all GitHub task-list bullets and nesting count, CRLF included', () => {
  const body = '* [X] star\r\n+ [ ] plus\r\n1. [x] numbered\r\n   - [ ] nested\r\n';
  assert.deepEqual(parseChecklist(body).map((i) => i.checked), [true, false, true, false]);
});

test('lines that are not task-list items are ignored', () => {
  const body = '- plain\n[ ] no bullet\n- [] no space\n-[ ] glued\n- [ ]\n- [ ]   \n- [y] wrong mark';
  assert.deepEqual(parseChecklist(body), []);
});

test('fenced code and HTML comments are skipped', () => {
  const body = ['- [x] real', '```', '- [ ] in fence', '```', '~~~', '- [ ] in tilde fence', '~~~',
    '<!-- - [ ] one line comment -->', '<!--', '- [ ] multi line comment', '-->', '- [ ] after'].join('\n');
  assert.deepEqual(parseChecklist(body).map((i) => i.text), ['real', 'after']);
});

test('an item that starts with an issue reference links to that issue', () => {
  const body = '- [ ] #12 Fix login\n- [x] other/repo#7\n- [ ] https://github.com/acme/widgets/issues/3 done\n- [ ] see #99';
  const children = checklistChildren(body, EPIC);
  assert.deepEqual(children.map((c) => c.number), [12, 7, 3, null]);
  assert.equal(children[0]?.url, 'https://github.com/acme/widgets/issues/12');
  assert.equal(children[1]?.url, 'https://github.com/other/repo/issues/7');
  assert.equal(children[3]?.url, null);
});

test('titles are capped so a hostile body can not bloat the snapshot', () => {
  const [child] = checklistChildren(`- [ ] ${'x'.repeat(1000)}`, EPIC);
  assert.equal(child?.title.length, 300);
});

test('the recorded checklist epic parses to 2 done, 2 todo, 1 dropped', () => {
  const body = (loadFixture('phase-b-checklist').body as { data: { repository: { e8: { body: string } } } })
    .data.repository.e8.body;
  const statuses = checklistChildren(body, EPIC).map((c) => c.status);
  assert.deepEqual(statuses, ['done', 'done', 'todo', 'todo', 'dropped']);
});
