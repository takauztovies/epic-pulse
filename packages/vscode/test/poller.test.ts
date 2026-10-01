import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Poller } from '../src/poller.js';

// Real timers with short intervals and runs that really take time. A probe
// counts the runs started and finished, and how many were in flight at once.
interface Probe {
  readonly run: () => Promise<void>;
  readonly runs: () => number;
  readonly finished: () => number;
  readonly peak: () => number;
}

function probe(runMs: number): Probe {
  let active = 0;
  let peak = 0;
  let runs = 0;
  const run = async () => {
    runs += 1;
    active += 1;
    peak = Math.max(peak, active);
    await sleep(runMs);
    active -= 1;
  };
  return { run, runs: () => runs, finished: () => runs - active, peak: () => peak };
}

const rethrow = (error: unknown) => assert.fail(`run threw: ${String(error)}`);

test('ticks and triggers never start a run beside the one in flight', async () => {
  const work = probe(40);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  const triggers = [poller.trigger(), poller.trigger(), poller.trigger()];
  // Room for several 40 ms runs even when the machine is busy.
  await sleep(300);
  await poller.dispose();
  await Promise.all(triggers);
  assert.equal(work.peak(), 1, 'two runs were in flight at once');
  assert.ok(work.runs() >= 3, `the timer kept polling: ${work.runs()} runs`);
});

test('a trigger during a run asks for exactly one more run, after it, and joins its promise', async () => {
  const work = probe(30);
  const poller = new Poller({ run: work.run, intervalMs: 60_000, focused: true, onError: rethrow });
  const first = poller.trigger();
  await sleep(5);
  const joined = [poller.trigger(), poller.trigger()];
  assert.equal(joined[0], first);
  await Promise.all([first, ...joined]);
  assert.deepEqual([work.runs(), work.peak()], [2, 1]);
  await poller.dispose();
});

// The run waits until released, so ticks land while it is in flight for as
// long as the test likes. Focus then goes, so only a queued run could start.
test('a tick that finds a run in flight is dropped, not queued behind it', async () => {
  let runs = 0;
  let release = () => {};
  const run = () => {
    runs += 1;
    return new Promise<void>((resolve) => (release = resolve));
  };
  const poller = new Poller({ run, intervalMs: 5, focused: true, onError: rethrow });
  void poller.trigger();
  await sleep(40);
  poller.setFocused(false);
  release();
  await sleep(20);
  assert.equal(runs, 1, 'a tick during the run queued another');
  release();
  await poller.dispose();
});

test('ticks wait for focus, and focus coming back runs at once', async () => {
  const work = probe(1);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: false, onError: rethrow });
  await sleep(60);
  assert.equal(work.runs(), 0, 'an unfocused window polled');
  poller.setFocused(true);
  await sleep(2);
  assert.ok(work.runs() >= 1, 'focus coming back did not run at once');
  poller.setFocused(false);
  await sleep(20);
  const settled = work.runs();
  await sleep(60);
  assert.equal(work.runs(), settled, 'a window that lost focus kept polling');
  await poller.dispose();
});

test('dispose waits for the run in flight, then nothing runs again', async () => {
  const work = probe(40);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  void poller.trigger();
  await sleep(10);
  await poller.dispose();
  const after = work.runs();
  assert.equal(work.finished(), after, 'dispose resolved while a run was still in flight');
  await poller.trigger();
  await sleep(50);
  assert.equal(work.runs(), after, 'a run started after dispose');
});

test('a run that throws is reported and the poller keeps going', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const run = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
  };
  const poller = new Poller({ run, intervalMs: 5, focused: true, onError: (error) => errors.push(error) });
  await poller.trigger();
  await sleep(30);
  await poller.dispose();
  assert.equal(errors.length, 1);
  assert.ok(calls >= 2, `the poller stopped after a failure: ${calls} calls`);
});

test('a new interval replaces the old one instead of adding a second timer', async () => {
  const work = probe(1);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  poller.setIntervalMs(60_000);
  await sleep(60);
  assert.equal(work.runs(), 0, 'the old 5 ms timer is still running');
  await poller.dispose();
});
