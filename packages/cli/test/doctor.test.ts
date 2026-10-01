import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventPayload } from './fixtures.js';
import { cliEnv, demoRepo, registryOf, runCli, sandbox, tempDir, type Sandbox } from './helpers.js';

const TOKEN = 'SENTINEL-doctor-token-0b9e';

async function doctor(cwd: string, box: Sandbox, extra: NodeJS.ProcessEnv = {}): Promise<ReadonlyMap<string, string>> {
  const run = await runCli(['doctor'], { cwd, env: cliEnv(box, extra) });
  assert.deepEqual([run.code, run.stderr], [0, '']);
  const [title, ...lines] = run.stdout.trimEnd().split('\n');
  assert.equal(title, 'epic-pulse doctor');
  return new Map(lines.map((line) => {
    const [label = '', ...value] = line.trim().split(': ');
    return [label, value.join(': ').trim()] as const;
  }));
}

test('doctor names where the token comes from and never prints the token', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const run = await runCli(['doctor'], { cwd: repo, env: cliEnv(box, { GH_TOKEN: TOKEN }) });
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(TOKEN));
  assert.equal((await doctor(repo, box, { GH_TOKEN: TOKEN })).get('token'), 'from GH_TOKEN');
  assert.match((await doctor(repo, box)).get('token') ?? '', /^none for github\.com: set GH_TOKEN or run `gh auth login`$/);
});

test('doctor reports the repository, its registry and whether the hook has run', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const before = await doctor(repo, box);
  assert.equal(before.get('node'), process.version);
  assert.deepEqual([before.get('repository'), before.get('remote')], [`${repo} (main checkout)`, 'github.com/takauztovies/epic-pulse']);
  assert.equal(before.get('registry'), registryOf(repo).dir);
  assert.match(before.get('hook') ?? '', /^inactive: no hook has written here/);
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: eventPayload('SessionStart', repo) });
  await runCli(['hook'], { cwd: repo, env: cliEnv(box), input: 'not a payload' });
  const after = await doctor(repo, box);
  assert.match(after.get('hook') ?? '', /^active: last ran \d{4}-\d\d-\d\dT/);
  assert.match(after.get('hook errors') ?? '', /^last: invalid_payload at \d{4}-/);
});

test('doctor reports whether the status line and the runtime copy are installed', async (t) => {
  const repo = demoRepo(t);
  const box = sandbox(t);
  const before = await doctor(repo, box);
  assert.match(before.get('statusLine (user)') ?? '', /^not installed: /);
  assert.match(before.get('runtime') ?? '', /^missing: /);
  assert.equal((await runCli(['statusline', 'install'], { cwd: repo, env: cliEnv(box) })).code, 0);
  const after = await doctor(repo, box);
  assert.match(after.get('statusLine (user)') ?? '', /^installed: /);
  assert.match(after.get('statusLine (project)') ?? '', /^not installed: /);
  assert.match(after.get('runtime') ?? '', /^present, the same build as this one: /);
});

test('doctor outside a repository says so instead of failing', async (t) => {
  const dir = tempDir(t);
  const report = await doctor(dir, sandbox(t));
  assert.deepEqual([report.get('repository'), report.get('registry')], ['not inside a git repository', 'none outside a git repository']);
});
