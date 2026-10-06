import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhaseB } from '../src/queries.js';
import { DEFAULT_PROGRESS } from '../src/progress-config.js';
import { countStatuses, deriveStatus, isStale, linkedOpenPrs, percentDone, STALE_AFTER_MS, pointsByStatus, weightedPercentDone } from '../src/status.js';
import type { RepoRef } from '../src/schemas/common.js';
import type { PrSource, SubIssueNode } from '../src/schemas/graphql.js';
import { loadFixture } from './helpers.js';

const REPO: RepoRef = { host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse' };

function demoNodes(): readonly SubIssueNode[] {
  const parsed = parsePhaseB(loadFixture('phase-b-subissues'));
  assert.ok(parsed.ok);
  return parsed.value.epics.get(1)!.subIssues.nodes.filter((n): n is SubIssueNode => n !== null);
}

function node(number: number): SubIssueNode {
  return structuredClone(demoNodes().find((n) => n.number === number)!);
}

// The demo repo's PR bodies say "Fixes #4" / "Fixes #5". When the fixtures were
// first recorded GitHub had left closedByPullRequestsReferences empty and only
// a cross-reference event linked them; it has since filled the field in, so
// the recording now holds both routes and the tests below isolate each one.
test('the recorded demo epic derives every status from real GitHub data', () => {
  const statuses = demoNodes().map((n) => [n.number, deriveStatus(n, REPO)]);
  assert.deepEqual(statuses, [
    [2, 'done'], [3, 'dropped'], [4, 'in_progress'], [5, 'in_review'], [6, 'in_progress'], [7, 'todo'],
  ]);
});

// The cross-reference event carries the whole PR; tests reuse that recorded PR.
function prOf(n: SubIssueNode): PrSource {
  const source = n.timelineItems.nodes[0]?.source;
  assert.ok(source, 'fixture issue has a cross-referencing PR');
  return source;
}

test('a closing PR reported by closedByPullRequestsReferences counts, without any timeline event', () => {
  const n = node(5);
  assert.equal(n.closedByPullRequestsReferences.nodes.length, 1, 'the recording no longer links the PR this way');
  assert.equal(deriveStatus({ ...n, timelineItems: { nodes: [] } }, REPO), 'in_review');
});

// The cross-reference route alone: GitHub's own link is taken away.
function withBody(number: number, body: string): SubIssueNode {
  const n = node(number);
  return { ...n, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [{ source: { ...prOf(n), body } }] } };
}

test('a cross-reference only counts when the PR body has a closing keyword for THIS issue', () => {
  assert.equal(linkedOpenPrs(withBody(4, 'Fixes #4'), REPO).length, 1);
  assert.equal(linkedOpenPrs(withBody(4, 'Fixes #40'), REPO).length, 0);
  assert.equal(linkedOpenPrs(withBody(4, 'Related to #4'), REPO).length, 0);
  assert.equal(linkedOpenPrs(withBody(4, 'Fixes #5'), REPO).length, 0);
  assert.equal(linkedOpenPrs(withBody(4, 'prefix #4'), REPO).length, 0);
});

test('every GitHub closing keyword form is recognised', () => {
  for (const body of ['closes #4', 'Closed #4', 'FIXED #4', 'fixes: #4', 'Resolves #4', 'resolved #4',
    'fixes takauztovies/epic-pulse#4', 'Fixes https://github.com/takauztovies/epic-pulse/issues/4',
    'Intro text.\n\nCloses #3, closes #4']) {
    assert.equal(linkedOpenPrs(withBody(4, body), REPO).length, 1, body);
  }
});

test('a closing keyword aimed at another repository does not link', () => {
  assert.equal(linkedOpenPrs(withBody(4, 'Fixes other/repo#4'), REPO).length, 0);
  assert.equal(linkedOpenPrs(withBody(4, 'Fixes https://github.com/other/repo/issues/4'), REPO).length, 0);
});

test('only OPEN pull requests from the same repository link an issue', () => {
  const n = { ...node(4), closedByPullRequestsReferences: { nodes: [] } };
  const source = prOf(n);
  const closed: SubIssueNode = { ...n, timelineItems: { nodes: [{ source: { ...source, state: 'MERGED' } }] } };
  const foreign: SubIssueNode = {
    ...n,
    timelineItems: { nodes: [{ source: { ...source, repository: { nameWithOwner: 'other/repo' } } }] },
  };
  assert.equal(linkedOpenPrs(closed, REPO).length, 0);
  assert.equal(linkedOpenPrs(foreign, REPO).length, 0);
});

test('closed issues: not planned and duplicate are dropped, anything else is done', () => {
  const closed = (stateReason: string | null): SubIssueNode => ({ ...node(7), state: 'CLOSED', stateReason });
  assert.equal(deriveStatus(closed('NOT_PLANNED'), REPO), 'dropped');
  assert.equal(deriveStatus(closed('DUPLICATE'), REPO), 'dropped');
  assert.equal(deriveStatus(closed('COMPLETED'), REPO), 'done');
  assert.equal(deriveStatus(closed(null), REPO), 'done');
});

test('a ready PR outranks a draft PR and an assignee', () => {
  const n = node(5);
  assert.equal(deriveStatus({ ...n, assignees: { totalCount: 2 } }, REPO), 'in_review');
});

test('percent excludes dropped items from the denominator (1 of 5 = 20, not 1 of 6)', () => {
  const counts = countStatuses(demoNodes().map((n) => ({ status: deriveStatus(n, REPO) })));
  assert.deepEqual(counts, { todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 });
  assert.equal(percentDone(counts), 20);
});

test('percent edge cases: nothing countable is 0, and 100 is only reached when complete', () => {
  const zero = { todo: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };
  assert.equal(percentDone(zero), 0);
  assert.equal(percentDone({ ...zero, dropped: 3 }), 0);
  assert.equal(percentDone({ ...zero, done: 199, todo: 1 }), 99);
  assert.equal(percentDone({ ...zero, done: 4, dropped: 2 }), 100);
});

test('data older than the stale window, or carrying an error, is marked stale', () => {
  const now = 10_000_000;
  assert.equal(isStale({ fetchedAt: now - 1000, error: null }, now), false);
  assert.equal(isStale({ fetchedAt: now - STALE_AFTER_MS, error: null }, now), false);
  assert.equal(isStale({ fetchedAt: now - STALE_AFTER_MS - 1, error: null }, now), true);
  assert.equal(isStale({ fetchedAt: now - 1000, error: 'rate_limited' }, now), true);
});

const NONE = { todo: 0, in_progress: 0, in_review: 0, done: 0, dropped: 0 };

test('weighted progress counts work in flight: in progress a quarter, in review three quarters, done whole', () => {
  assert.equal(weightedPercentDone({ ...NONE, in_progress: 4 }), 25);
  assert.equal(weightedPercentDone({ ...NONE, in_review: 4 }), 75);
  assert.equal(weightedPercentDone({ ...NONE, todo: 1, in_progress: 2, in_review: 1, done: 1, dropped: 1 }), 45);
});

test('weighted progress shares the done-percent edges: dropped leaves the denominator, nothing countable is 0, 100 only when complete', () => {
  assert.equal(weightedPercentDone({ ...NONE, done: 1, dropped: 4 }), 100);
  assert.equal(weightedPercentDone({ ...NONE, dropped: 3 }), 0);
  assert.equal(weightedPercentDone(NONE), 0);
  assert.equal(weightedPercentDone({ ...NONE, done: 199, in_review: 1 }), 99);
  assert.ok(weightedPercentDone({ ...NONE, in_review: 50 }) < 100);
});

const child = (status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'dropped', ...labels: string[]) => ({ number: 1, title: 't', url: null, status, ...(labels.length > 0 ? { labels } : {}) });

test('a finished large item moves progress more than a finished small one', () => {
  const small = pointsByStatus([child('done', 'size/xs'), child('todo', 'size/xl')]);
  const large = pointsByStatus([child('done', 'size/xl'), child('todo', 'size/xs')]);
  assert.deepEqual([percentDone(small), percentDone(large)], [11, 88]);
  assert.deepEqual([weightedPercentDone(small), weightedPercentDone(large)], [11, 88]);
});

test('without size labels every item counts the same, so progress is the plain item ratio', () => {
  const children = [child('done'), child('in_progress'), child('todo'), child('todo'), child('dropped')];
  assert.equal(percentDone(pointsByStatus(children)), percentDone(countStatuses(children)));
  assert.equal(weightedPercentDone(pointsByStatus(children)), weightedPercentDone(countStatuses(children)));
});

test('an unlabelled item among sized ones counts as medium, and an unknown size label as unsized', () => {
  const points = pointsByStatus([child('done', 'size/m'), child('todo'), child('todo', 'size/huge')]);
  assert.deepEqual([points.done, points.todo], [3, 6]);
});

test('the size comes from whichever label names one, and the larger counts when an item carries two', () => {
  assert.equal(pointsByStatus([child('done', 'bug', 'size/l', 'p1')]).done, 5);
  assert.equal(pointsByStatus([child('done', 'size/s', 'size/xl')]).done, 8);
});

test('configured sizes and in-flight weights replace the defaults', () => {
  const progress = { ...DEFAULT_PROGRESS, inProgress: 50, inReview: 90, sizes: { 'est:1': 1, 'est:4': 4 }, unsized: 2 };
  const points = pointsByStatus([child('done', 'est:4'), child('in_progress', 'est:1'), child('todo'), child('done', 'size/xl')], progress);
  assert.deepEqual([points.done, points.in_progress, points.todo], [4 + 2, 1, 2]);
  assert.equal(weightedPercentDone(pointsByStatus([child('in_progress'), child('in_progress')]), progress), 50);
  assert.equal(weightedPercentDone(pointsByStatus([child('in_review'), child('todo')]), progress), 45);
});
