import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchIssueNumber, compileBranchPattern, DEFAULT_BRANCH_PATTERN, isBacktrackSafe } from '../src/branch-pattern.js';
import { CONFIG_FILE, DEFAULT_CONFIG, isIgnoredPath, loadConfig, parseConfig } from '../src/config.js';
import { tempDir } from './repo-helpers.js';

test('the default pattern reads a leading issue number behind at most one prefix segment', () => {
  const cases: readonly (readonly [string, number | undefined])[] = [
    ['fix/123-thing', 123], ['feat/77-widget', 77], ['42', 42], ['#12-x', 12], ['fix/#9_x', 9], ['7.x', undefined],
    ['main', undefined], ['fix/agent-eval', undefined], ['feature/v2-api', undefined], ['a/b/12-x', undefined], ['12abc', undefined],
  ];
  for (const [branch, expected] of cases) assert.equal(branchIssueNumber(branch, DEFAULT_BRANCH_PATTERN), expected, branch);
});

test('the default pattern needs a dash, an underscore or the end after the number, so a version never binds', () => {
  const cases: readonly (readonly [string, number | undefined])[] = [
    ['feat/123-x', 123], ['fix/123_x', 123], ['123-x', 123], ['feat/123', 123],
    ['release/1.2.3', undefined], ['v2', undefined], ['hotfix/2.0', undefined], ['deps/1.0.0-beta', undefined],
  ];
  for (const [branch, expected] of cases) assert.equal(branchIssueNumber(branch, DEFAULT_BRANCH_PATTERN), expected, branch);
});

test('a valid user pattern replaces the default', () => {
  const config = parseConfig({ branchIssuePattern: '^issue-(\\d+)$' });
  assert.equal(branchIssueNumber('issue-45', config.branchIssuePattern), 45);
  assert.equal(branchIssueNumber('fix/45-x', config.branchIssuePattern), undefined);
  assert.equal(branchIssueNumber('issue-7', parseConfig({ branchIssuePattern: '^issue-(?<n>\\d+)' }).branchIssuePattern), 7);
});

test('an unusable user pattern falls back to the default, and says why', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['(', 'invalid'], ['^\\d+$', 'capture_groups'], ['^(a)(\\d+)', 'capture_groups'], ['', 'capture_groups'],
    [`(\\d+)${'x'.repeat(200)}`, 'too_long'], ['^(\\d+)+$', 'backtracking'], ['^(?:a|ab)*(\\d+)', 'backtracking'],
  ];
  for (const [source, reason] of rejected) {
    assert.deepEqual(compileBranchPattern(source), { ok: false, error: reason }, source);
    assert.equal(parseConfig({ branchIssuePattern: source }).branchIssuePattern, DEFAULT_BRANCH_PATTERN, source);
  }
});

test('the backtracking check refuses repeated groups that hold a repetition or an alternation', () => {
  for (const unsafe of ['(a+)+', '(a|ab)*', '((a+)b)+', '(?:\\d+)+', '(\\d*){2,}', '(a+){3}', '(a+)+?']) {
    assert.equal(isBacktrackSafe(unsafe), false, unsafe);
  }
  for (const safe of [DEFAULT_BRANCH_PATTERN.source, '[(]+(\\d+)', '\\(+(\\d+)', '^(\\d+)?x', '^(\\d+){1}', '^(?:ab)+(\\d+)', '(?<n>\\d+)x{2,}']) {
    assert.equal(isBacktrackSafe(safe), true, safe);
  }
});

test('only a digit capture of bounded length yields a number', () => {
  const words = parseConfig({ branchIssuePattern: '^(\\w+)$' }).branchIssuePattern;
  assert.equal(branchIssueNumber('main', words), undefined);
  assert.equal(branchIssueNumber('123', words), 123);
  assert.equal(branchIssueNumber(`1-${'x'.repeat(300)}`, DEFAULT_BRANCH_PATTERN), undefined);
});

test('the config file is read from the root; missing, oversized or malformed files give defaults', async (t) => {
  const root = tempDir(t);
  assert.deepEqual(await loadConfig(root), DEFAULT_CONFIG);
  for (const text of ['not json', '[]', 'null', '"x"', JSON.stringify({ ignorePaths: ['a'.repeat(70_000)] })]) {
    writeFileSync(join(root, CONFIG_FILE), text);
    assert.deepEqual(await loadConfig(root), DEFAULT_CONFIG, text.slice(0, 20));
  }
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ ignoreMainCheckout: true, ignorePaths: ['docs/'] }));
  assert.deepEqual(await loadConfig(root), { ...DEFAULT_CONFIG, ignoreMainCheckout: true, ignorePaths: ['docs'] });
});

test('a directory where the config file should be gives defaults, not a crash', async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, CONFIG_FILE));
  assert.deepEqual(await loadConfig(root), DEFAULT_CONFIG);
});

test('a wrong-typed field falls back on its own without voiding the file', () => {
  const config = parseConfig({ branchIssuePattern: 5, ignorePaths: 'docs', ignoreMainCheckout: true });
  assert.equal(config.branchIssuePattern, DEFAULT_BRANCH_PATTERN);
  assert.deepEqual(config.ignorePaths, []);
  assert.equal(config.ignoreMainCheckout, true);
  assert.equal(parseConfig({ ignoreMainCheckout: 'yes' }).ignoreMainCheckout, false);
});

test('ignorePaths are normalised repository-relative prefixes; unusable entries are dropped', () => {
  const entries = ['docs/', './scripts//gen', 'vendor\\lib', '/abs', '\\abs', 'C:/x', '../up', 'a/../b', '', '.', 'docs', 5, null, 'x'.repeat(201)];
  assert.deepEqual(parseConfig({ ignorePaths: entries }).ignorePaths, ['docs', 'scripts/gen', 'vendor/lib']);
  const many = Array.from({ length: 150 }, (_, i) => `dir${i}`);
  assert.equal(parseConfig({ ignorePaths: many }).ignorePaths.length, 100);
});

test('an ignore prefix matches whole path segments under the worktree root', () => {
  const config = parseConfig({ ignorePaths: ['docs', 'scripts/gen'] });
  const root = join('/', 'r', 'wt');
  const at = (...parts: string[]) => isIgnoredPath(config, root, join(root, ...parts));
  assert.equal(at('docs', 'a.md'), true);
  assert.equal(at('docs'), true);
  assert.equal(at('scripts', 'gen', 'x.ts'), true);
  assert.equal(at('docs-site', 'a.md'), false);
  assert.equal(at('src', 'docs', 'a.md'), false);
  assert.equal(at('scripts', 'general.ts'), false);
});
