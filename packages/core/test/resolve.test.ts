import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRef, refKey } from '../src/ref.js';
import { buildEpic, epicKeysFor, epicRefFor, unresolvedRefs } from '../src/resolve.js';
import { parsePhaseA, parsePhaseB } from '../src/queries.js';
import type { EpicNode } from '../src/schemas/graphql.js';
import type { Snapshot } from '../src/schemas/snapshot.js';
import { loadFixture } from './helpers.js';

const ref = (number: number) => makeRef({ host: 'github.com', owner: 'takauztovies', repo: 'epic-pulse', number })!;

function phaseA() {
  const parsed = parsePhaseA(loadFixture('phase-a'));
  assert.ok(parsed.ok);
  return parsed.value.issues;
}

function epicNode(fixture: string, number: number): EpicNode {
  const parsed = parsePhaseB(loadFixture(fixture));
  assert.ok(parsed.ok);
  return structuredClone(parsed.value.epics.get(number)!);
}

test('a sub-issue resolves to its parent, an epic and a checklist epic to themselves', () => {
  const issues = phaseA();
  assert.equal(refKey(epicRefFor(ref(4), issues.get(4)!)!), 'github.com/takauztovies/epic-pulse#1');
  assert.equal(refKey(epicRefFor(ref(1), issues.get(1)!)!), 'github.com/takauztovies/epic-pulse#1');
  assert.equal(refKey(epicRefFor(ref(8), issues.get(8)!)!), 'github.com/takauztovies/epic-pulse#8');
  assert.equal(epicRefFor(ref(9999), issues.get(9999)!), null);
});

test('a parent in another repository keeps its own owner and repo', () => {
  const node = { number: 4, url: 'u', parent: { number: 30, url: 'p', repository: { nameWithOwner: 'Other/Tracker' } } };
  assert.equal(refKey(epicRefFor(ref(4), node)!), 'github.com/other/tracker#30');
});

test('the sub-issue epic builds six children with derived statuses and the 20 percent inputs', () => {
  const epic = buildEpic(epicNode('phase-b-subissues', 1), ref(1))!;
  assert.equal(epic.kind, 'subissues');
  assert.equal(epic.truncated, false);
  assert.deepEqual(epic.children.map((c) => [c.number, c.status]), [
    [2, 'done'], [3, 'dropped'], [4, 'in_progress'], [5, 'in_review'], [6, 'in_progress'], [7, 'todo'],
  ]);
  assert.equal(epic.children[0]?.url, 'https://github.com/takauztovies/epic-pulse/issues/2');
});

// #5 moved into another repository than the epic's (GitHub links sub-issues
// across repositories), and the ready pull request that closes it, by either
// route, into `prRepo`.
function crossRepoFive(prRepo: string): EpicNode {
  const node = epicNode('phase-b-subissues', 1);
  const repository = { nameWithOwner: prRepo };
  const nodes = node.subIssues.nodes.map((sub) => {
    if (sub?.number !== 5) return sub;
    const linked = sub.closedByPullRequestsReferences.nodes.map((pr) => (pr ? { ...pr, repository } : pr));
    const crossed = sub.timelineItems.nodes.map((item) => (item?.source ? { ...item, source: { ...item.source, repository } } : item));
    const own = { url: 'https://github.com/acme/widgets/issues/5', repository: { nameWithOwner: 'acme/widgets' } };
    return { ...sub, ...own, closedByPullRequestsReferences: { nodes: linked }, timelineItems: { nodes: crossed } };
  });
  return { ...node, subIssues: { ...node.subIssues, nodes } };
}

test('a sub-issue in another repository is judged by the pull requests of its own repository', () => {
  const status = (prRepo: string) => buildEpic(crossRepoFive(prRepo), ref(1))?.children.find((child) => child.number === 5)?.status;
  assert.equal(status('acme/widgets'), 'in_review');
  assert.equal(status('takauztovies/epic-pulse'), 'todo', "a pull request closing #5 of the epic's repository closes another issue");
});

test('the checkbox epic builds children from its body', () => {
  const epic = buildEpic(epicNode('phase-b-checklist', 8), ref(8))!;
  assert.equal(epic.kind, 'checklist');
  assert.deepEqual(epic.children.map((c) => c.status), ['done', 'done', 'todo', 'todo', 'dropped']);
  assert.equal(epic.children[4]?.title, 'Translate into French');
});

test('an epic with more sub-issues than one page is flagged truncated, not shown as complete', () => {
  const node = epicNode('phase-b-subissues', 1);
  const big: EpicNode = { ...node, subIssues: { ...node.subIssues, totalCount: 150 } };
  assert.equal(buildEpic(big, ref(1))?.truncated, true);
});

test('an issue with no sub-issues and no checklist is not an epic', () => {
  const node = epicNode('phase-b-checklist', 8);
  assert.equal(buildEpic({ ...node, body: 'Just a normal issue.' }, ref(8)), null);
});

test('resolution lookups: distinct epic keys, and refs never resolved', () => {
  const snapshot: Snapshot = {
    v: 1, updatedAt: 1, epics: {}, usage: { windowStart: 0, points: 0 }, rateLimit: null, error: null, detail: null,
    issues: {
      [refKey(ref(4))]: { epic: ref(1), resolvedAt: 1 },
      [refKey(ref(5))]: { epic: ref(1), resolvedAt: 1 },
      [refKey(ref(7))]: { epic: null, resolvedAt: 1 },
    },
  };
  assert.deepEqual(epicKeysFor([ref(4), ref(5), ref(7)], snapshot), ['github.com/takauztovies/epic-pulse#1']);
  assert.deepEqual(unresolvedRefs([ref(4), ref(6), ref(7)], snapshot).map((r) => r.number), [6]);
});
