import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeSnapshot } from '@epic-pulse/core';
import { bashPayload, demoSnapshot, eventPayload, statusPayload } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox } from './helpers.js';

const RUNS = 20;
// A tripwire, not the target: it catches a render that waits on the network
// or on the refresh, without failing on a busy machine. The targets (status
// line under 100 ms, hook under 50 ms) are reported below and checked by hand.
const TRIPWIRE_MS = 1500;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN);
}

// Wall clock around the whole process, Node start-up included, one at a time.
async function timed(args: readonly string[], options: Parameters<typeof runCli>[1]): Promise<readonly number[]> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const run = await runCli(args, options);
    assert.equal(run.code, 0);
    samples.push(run.ms);
  }
  return samples;
}

test('status line and hook latency over 20 runs each', async (t) => {
  const repo = demoRepo(t);
  const env = cliEnv(sandbox(t));
  await runCli(['hook'], { cwd: repo, env, input: eventPayload('SessionStart', repo) });
  await runCli(['hook'], { cwd: repo, env, input: bashPayload('gh issue comment 4 -b hi', repo) });
  await writeSnapshot(registryOf(repo).snapshotFile, demoSnapshot(Date.now()));
  const status = await timed(['statusline'], { cwd: repo, env, input: statusPayload(repo) });
  const hook = await timed(['hook'], { cwd: repo, env, input: bashPayload('gh issue comment 4 -b hi', repo) });
  t.diagnostic(`statusline p50 ${percentile(status, 50)} ms, p95 ${percentile(status, 95)} ms`);
  t.diagnostic(`hook p50 ${percentile(hook, 50)} ms, p95 ${percentile(hook, 95)} ms`);
  assert.ok(percentile(status, 95) < TRIPWIRE_MS && percentile(hook, 95) < TRIPWIRE_MS);
});
