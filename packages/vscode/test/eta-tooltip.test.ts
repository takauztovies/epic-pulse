import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Model } from '../src/model.js';
import { escapeMarkdown } from '../src/markdown.js';
import { overviewHtml } from '../src/overview-html.js';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';
import { modelOf } from './model-helpers.js';
import { demo, demoSnapshot, makeRegistry, pacedSnapshot, SESSION_A, zoneFor } from './registry-helpers.js';

// Real registry files read through the production path, with `now` given: no
// clock is involved. The recorded demo epic has its items closed on the days
// the snapshot names (pacedSnapshot). The zone is pinned: the ETA is shown as a
// day on the machine's own calendar.
const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const ETA = 'ETA: 29.10. (at the pace of the last 14 days)';

async function pacedModel(t: TestContext, snapshot = pacedSnapshot(NOW)): Promise<Model> {
  zoneFor(t)('Europe/Berlin');
  const repo = await makeRegistry(t, { sessions: [{ id: SESSION_A, binds: [demo(4)] }], snapshot }, NOW);
  return modelOf([repo], NOW);
}

async function epicTooltip(t: TestContext, snapshot = pacedSnapshot(NOW)): Promise<readonly string[]> {
  const [epic] = treeOf(await pacedModel(t, snapshot));
  assert.equal(epic?.kind, 'epic');
  return epic?.tooltip.split('\n') ?? [];
}

test('the epic hover says when it is on course to finish, right after how much moved this week', async (t) => {
  const lines = await epicTooltip(t);
  const moved = lines.findIndex((line) => line.endsWith('done in the last 7 days'));
  assert.ok(moved > 0, lines.join('\n'));
  assert.equal(lines[moved + 1], ETA);
  assert.equal(lines.filter((line) => line.includes('ETA')).length, 1, 'once, not twice');
});

test('the status bar hover and the Overview card show the same ETA line', async (t) => {
  const model = await pacedModel(t);
  assert.ok(statusBarOf(model).tooltip.includes(`  \n${escapeMarkdown(ETA)}  \n`), statusBarOf(model).tooltip);
  assert.ok(overviewHtml(model.epics, 'n0nce', NOW).includes(`<div class="meta">${ETA}</div>`));
});

test('an epic with no pace has no ETA line in its hover', async (t) => {
  const lines = await epicTooltip(t, demoSnapshot(NOW));
  assert.deepEqual(lines.filter((line) => line.includes('ETA')), []);
});
