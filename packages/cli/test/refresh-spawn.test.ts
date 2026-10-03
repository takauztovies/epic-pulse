import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnDetached } from '../src/refresh-spawn.js';
import { tempDir, waitFor } from './helpers.js';

// The status line starts its refresh detached, in whatever directory it was
// started in: the repository. On Windows a running process keeps its working
// directory from being removed, so the refresh held the repository (a worktree,
// a checkout, a test's temp copy) for as long as it ran and removing it failed
// with EBUSY (CI run 37160481988). These start a real process, which reports
// where it runs, since a process's working directory is not otherwise visible.

const REPORT = "require('fs').writeFileSync(process.env.EP_REPORT, `${process.cwd()}\\n${process.env.EP_MARK}`)";

async function whereItRuns(t: Parameters<typeof tempDir>[0], env: NodeJS.ProcessEnv = process.env): Promise<{ readonly cwd: string; readonly mark: string }> {
  const report = join(tempDir(t), 'report.txt');
  spawnDetached(process.execPath, ['-e', REPORT], { ...env, EP_REPORT: report, EP_MARK: 'passed-through' });
  assert.ok(await waitFor(() => existsSync(report), 5000), 'the detached process never reported');
  const [cwd = '', mark = ''] = readFileSync(report, 'utf8').split('\n');
  return { cwd: realpathSync.native(cwd), mark };
}

test('a detached process runs in the home directory, not where its parent runs, and keeps the environment it is given', async (t) => {
  const run = await whereItRuns(t);
  assert.equal(run.cwd, realpathSync.native(homedir()));
  assert.equal(run.mark, 'passed-through');
});

// HOME=/nonexistent is what an account without a home directory has. A working
// directory that is not there stops the process from starting at all, which
// would silently end every refresh, so the temp directory stands in for it.
test('a home directory that is not there is not used: the temp directory is', async (t) => {
  const kept = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  const missing = join(tempDir(t), 'no-such-home');
  process.env['HOME'] = missing;
  process.env['USERPROFILE'] = missing;
  t.after(() => {
    for (const [name, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  assert.equal((await whereItRuns(t)).cwd, realpathSync.native(tmpdir()));
});
