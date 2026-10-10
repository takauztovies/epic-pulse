import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhaseB } from '../src/queries.js';
import { buildEpic } from '../src/resolve.js';
import type { EpicNode, SubIssueNode } from '../src/schemas/graphql.js';
import { deriveStatus, linkedOpenPrs, MAX_MENTIONS, mentioningOpenPrs } from '../src/status.js';
import { loadFixture } from './helpers.js';
import { demo } from './snapshot-helpers.js';

// Real answers recorded from the demo repository: #46 has an open, ready PR (#51)
// from the branch `46-demo-branch-link` that never mentions it; #50 is mentioned,
// not closed, by the open draft PR #52; #48 is assigned with no PR.
function program(): EpicNode {
  const parsed = parsePhaseB(loadFixture('phase-b-nested-43'));
  assert.ok(parsed.ok);
  return parsed.value.epics.get(43)!;
}

const child = (epic: EpicNode, number: number): SubIssueNode => epic.subIssues.nodes.find((node) => node?.number === number)!;

test('an open PR from a branch named for the issue is its work, though it never mentions it', () => {
  const node = child(program(), 46);
  assert.deepEqual(node.closedByPullRequestsReferences.nodes, [], 'GitHub itself links nothing');
  assert.deepEqual(linkedOpenPrs(node, demo(46)).map((pr) => [pr.number, pr.headRefName, pr.isDraft]), [[51, '46-demo-branch-link', false]]);
  assert.equal(deriveStatus(node, demo(46)), 'in_review');
});

test('an open PR that mentions the issue without closing it moves it to in progress, never to review', () => {
  const node = child(program(), 50);
  assert.deepEqual(mentioningOpenPrs(node, demo(50)).map((pr) => pr.number), [52]);
  assert.deepEqual(linkedOpenPrs(node, demo(50)), []);
  assert.equal(deriveStatus(node, demo(50)), 'in_progress');
  const ready = { ...node, timelineItems: { nodes: node.timelineItems.nodes.map((item) => (item?.source ? { ...item, source: { ...item.source, isDraft: false } } : item)) } };
  assert.equal(deriveStatus(ready, demo(50)), 'in_progress', 'a ready PR that only mentions it is still not its review');
});

// The same PR body, naming more issues than MAX_MENTIONS: a release note or a
// sweep, not work on any one of them.
test('a PR that names more than a few issues moves none of them', () => {
  const node = child(program(), 50);
  const sweep = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `#${50 + i}`).join(', ');
  const swept = { ...node, timelineItems: { nodes: node.timelineItems.nodes.map((item) => (item?.source ? { ...item, source: { ...item.source, body: `Touches ${sweep}.` } } : item)) } };
  assert.deepEqual(mentioningOpenPrs(swept, demo(50)), []);
  assert.equal(deriveStatus(swept, demo(50)), 'todo');
  const few = { ...node, timelineItems: { nodes: node.timelineItems.nodes.map((item) => (item?.source ? { ...item, source: { ...item.source, body: 'See #50, #51 and https://github.com/takauztovies/epic-pulse/issues/52.' } } : item)) } };
  assert.equal(deriveStatus(few, demo(50)), 'in_progress');
});

test('a branch for one issue is not taken for another, and a closed or merged PR is not work in flight', () => {
  const node = child(program(), 50);
  assert.deepEqual(node.branchPullRequests, [], 'no open PR has a branch named for #50');
  const closed = { ...child(program(), 46), branchPullRequests: child(program(), 46).branchPullRequests?.map((pr) => ({ ...pr, state: 'CLOSED' })) };
  assert.equal(deriveStatus(closed, demo(46)), 'todo');
});

test('the epic built from the recording carries these statuses and the PR count', () => {
  const epic = buildEpic(program(), demo(43))!;
  assert.deepEqual(epic.children.map((c) => [c.number, c.status, c.openPrs ?? 0]), [[44, 'todo', 0], [46, 'in_review', 1], [50, 'in_progress', 0]]);
});
