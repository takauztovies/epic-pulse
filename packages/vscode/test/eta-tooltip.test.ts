import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { treeOf } from '../src/tree-model.js';
import { modelOf } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, pacedSnapshot, SESSION_A } from './registry-helpers.js';

// Real registry files read through the production path, with `now` given: no
// clock is involved. The recorded demo epic has its items closed on the days
// the snapshot names (pacedSnapshot).
const NOW = Date.parse('2026-10-08T12:00:00.000Z');

async function epicTooltip(t: TestContext, snapshot = pacedSnapshot(NOW)): Promise<readonly string[]> {
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot }, NOW);
  const [epic] = treeOf(await modelOf([repo], NOW));
  assert.equal(epic?.kind, 'epic');
  return epic?.tooltip.split('\n') ?? [];
}

test('the epic hover says when it is on course to finish, right after how much moved this week', async (t) => {
  const lines = await epicTooltip(t);
  const moved = lines.findIndex((line) => line.endsWith('done in the last 7 days'));
  assert.ok(moved > 0, lines.join('\n'));
  assert.equal(lines[moved + 1], 'ETA: 29.10. (at the pace of the last 14 days)');
});

test('an epic with no pace has no ETA line in its hover', async (t) => {
  const lines = await epicTooltip(t, demoSnapshot(NOW));
  assert.deepEqual(lines.filter((line) => line.includes('ETA')), []);
});
