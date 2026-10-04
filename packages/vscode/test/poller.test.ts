import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Poller, type PollMode } from '../src/poller.js';

// Real timers with short intervals and runs that really take time. A probe
// counts the runs started and finished, and how many were in flight at once.
interface Probe {
  readonly run: (mode: PollMode) => Promise<void>;
  readonly runs: () => number;
  readonly modes: () => readonly PollMode[];
  readonly finished: () => number;
  readonly peak: () => number;
}

function probe(runMs: number): Probe {
  let active = 0;
  let peak = 0;
  let runs = 0;
  const modes: PollMode[] = [];
  const run = async (mode: PollMode) => {
    runs += 1;
    modes.push(mode);
    active += 1;
    peak = Math.max(peak, active);
    await sleep(runMs);
    active -= 1;
  };
  return { run, runs: () => runs, modes: () => modes, finished: () => runs - active, peak: () => peak };
}

const count = (work: Probe, mode: PollMode) => work.modes().filter((run) => run === mode).length;

const rethrow = (error: unknown) => assert.fail(`run threw: ${String(error)}`);

test('ticks and triggers never start a run beside the one in flight', async (t) => {
  const work = probe(40);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  t.after(() => poller.dispose());
  const triggers = [poller.trigger(), poller.trigger(), poller.trigger()];
  // Room for several 40 ms runs even when the machine is busy.
  await sleep(300);
  await poller.dispose();
  await Promise.all(triggers);
  assert.equal(work.peak(), 1, 'two runs were in flight at once');
  assert.ok(work.runs() >= 3, `the timer kept polling: ${work.runs()} runs`);
});

test('a trigger during a run asks for exactly one more run, after it, and joins its promise', async (t) => {
  const work = probe(30);
  const poller = new Poller({ run: work.run, intervalMs: 60_000, focused: true, onError: rethrow });
  t.after(() => poller.dispose());
  const first = poller.trigger();
  await sleep(5);
  const joined = [poller.trigger(), poller.trigger()];
  assert.equal(joined[0], first);
  await Promise.all([first, ...joined]);
  assert.deepEqual([work.runs(), work.peak()], [2, 1]);
  await poller.dispose();
});

// The run waits until released, so ticks land while it is in flight for as
// long as the test likes. Focus then goes, so from then on ticks only read: a
// refresh could only be one a tick queued behind the run.
test('a tick that finds a run in flight is dropped, not queued behind it', async (t) => {
  const modes: PollMode[] = [];
  let release = () => {};
  const run = (mode: PollMode) => {
    modes.push(mode);
    return new Promise<void>((resolve) => (release = resolve));
  };
  const poller = new Poller({ run, intervalMs: 5, focused: true, onError: rethrow });
  t.after(() => {
    release();
    return poller.dispose();
  });
  void poller.trigger();
  await sleep(40);
  poller.setFocused(false);
  release();
  await sleep(20);
  assert.deepEqual(modes.filter((mode) => mode === 'refresh'), ['refresh'], 'a tick during the run queued another refresh');
  release();
  await poller.dispose();
});

// A run that records its mode and waits until it is released, so the test
// decides when each run ends. `open` releases everything, now and later.
function gated() {
  const modes: PollMode[] = [];
  const waiting: (() => void)[] = [];
  let opened = false;
  const run = (mode: PollMode) => {
    modes.push(mode);
    return opened ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve));
  };
  const open = () => {
    opened = true;
    for (const resolve of waiting.splice(0)) resolve();
  };
  return { run, modes: () => modes, release: () => waiting.shift()?.(), open };
}

// Real timers: waits for a condition, within a deadline, rather than for a time.
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

// An unfocused window fetches nothing, but its status bar and tree still age:
// what was fresh turns stale, and what another refresher wrote shows up. So it
// keeps reading the files on the interval, and only the refresh waits for focus.
test('an unfocused window keeps reading on the interval and never refreshes, and focus coming back refreshes at once', async (t) => {
  const work = probe(1);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: false, onError: rethrow });
  t.after(() => poller.dispose());
  await sleep(60);
  assert.equal(count(work, 'refresh'), 0, 'an unfocused window refreshed');
  assert.ok(count(work, 'read') >= 3, `an unfocused window stopped reading: ${count(work, 'read')} reads`);
  poller.setFocused(true);
  await sleep(2);
  assert.ok(count(work, 'refresh') >= 1, 'focus coming back did not refresh at once');
  poller.setFocused(false);
  await sleep(20);
  const [refreshed, read] = [count(work, 'refresh'), count(work, 'read')];
  await sleep(60);
  assert.equal(count(work, 'refresh'), refreshed, 'a window that lost focus kept refreshing');
  assert.ok(count(work, 'read') > read, 'a window that lost focus stopped reading');
});

// What prompted a refresh (a click on Refresh, a sign-in) may be newer than the
// files the read in flight is looking at, so the read can not stand in for it.
test('a refresh asked for while a read is in flight runs after it', async (t) => {
  const work = gated();
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: false, onError: rethrow });
  t.after(() => {
    work.open();
    return poller.dispose();
  });
  await until(() => work.modes().length === 1, 'the first tick to start a read');
  const asked = poller.trigger();
  work.release();
  await until(() => work.modes().length === 2, 'the refresh to start after the read');
  assert.deepEqual(work.modes(), ['read', 'refresh']);
  work.open();
  await asked;
});

// A refresh reads the files itself at its end, and a read in flight is as new
// as a second one would be: neither is run again for it.
test('a read asked for while a refresh is in flight joins it and queues nothing', async (t) => {
  const work = gated();
  const poller = new Poller({ run: work.run, intervalMs: 60_000, focused: true, onError: rethrow });
  t.after(() => {
    work.open();
    return poller.dispose();
  });
  const refreshing = poller.trigger();
  await until(() => work.modes().length === 1, 'the refresh to start');
  assert.equal(poller.trigger('read'), refreshing);
  work.open();
  await refreshing;
  assert.deepEqual(work.modes(), ['refresh']);
});

test('a read asked for while a read is in flight joins it and queues nothing', async (t) => {
  const work = gated();
  const poller = new Poller({ run: work.run, intervalMs: 60_000, focused: false, onError: rethrow });
  t.after(() => {
    work.open();
    return poller.dispose();
  });
  const reading = poller.trigger('read');
  await until(() => work.modes().length === 1, 'the read to start');
  assert.equal(poller.trigger('read'), reading);
  work.open();
  await reading;
  assert.deepEqual(work.modes(), ['read']);
});

test('dispose waits for the run in flight, then nothing runs again', async (t) => {
  const work = probe(40);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  t.after(() => poller.dispose());
  void poller.trigger();
  await sleep(10);
  await poller.dispose();
  const after = work.runs();
  assert.equal(work.finished(), after, 'dispose resolved while a run was still in flight');
  await poller.trigger();
  await sleep(50);
  assert.equal(work.runs(), after, 'a run started after dispose');
});

test('a run that throws is reported and the poller keeps going', async (t) => {
  const errors: unknown[] = [];
  let calls = 0;
  const run = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
  };
  const poller = new Poller({ run, intervalMs: 5, focused: true, onError: (error) => errors.push(error) });
  t.after(() => poller.dispose());
  await poller.trigger();
  await sleep(30);
  await poller.dispose();
  assert.equal(errors.length, 1);
  assert.ok(calls >= 2, `the poller stopped after a failure: ${calls} calls`);
});

test('a new interval replaces the old one instead of adding a second timer', async (t) => {
  const work = probe(1);
  const poller = new Poller({ run: work.run, intervalMs: 5, focused: true, onError: rethrow });
  t.after(() => poller.dispose());
  poller.setIntervalMs(60_000);
  await sleep(60);
  assert.equal(work.runs(), 0, 'the old 5 ms timer is still running');
  await poller.dispose();
});
