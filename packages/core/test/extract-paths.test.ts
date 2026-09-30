import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { extract } from '../src/extract.js';
import { pathsFor } from '../src/paths.js';
import { refKey } from '../src/ref.js';
import { appendRegistryLine, readSession } from '../src/registry.js';
import type { HookPayload } from '../src/schemas/hook.js';
import { bash, fileTool, quoted, SESSION, signals, widgetsRepo, writeConfig } from './extract-helpers.js';
import { addWorktree, git, makeRepo, tempDir } from './repo-helpers.js';

const W12 = 'branch:github.com/acme/widgets#12';

test('an edit in a worktree whose branch names an issue binds it via the branch', async (t) => {
  const { wt } = widgetsRepo(t);
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.deepEqual(await signals(fileTool(tool, join(wt, 'src', 'new-file.ts'))), [W12], tool);
  }
});

test('no issue in the branch, a detached HEAD or no remote binds nothing', async (t) => {
  const { repo, wt } = widgetsRepo(t);
  assert.deepEqual(await signals(fileTool('Edit', join(repo.root, 'a.ts'))), []);
  const noRemote = makeRepo(t, '7-orphan').root;
  assert.deepEqual(await signals(fileTool('Edit', join(noRemote, 'a.ts'))), []);
  git(wt, ['checkout', '-q', '--detach']);
  assert.deepEqual(await signals(fileTool('Edit', join(wt, 'a.ts'))), []);
});

test('ignoreMainCheckout skips the main checkout and nothing else', async (t) => {
  const { repo, wt } = widgetsRepo(t, '5-hotfix');
  const inMain = fileTool('Edit', join(repo.root, 'src', 'a.ts'));
  assert.deepEqual(await signals(inMain), ['branch:github.com/acme/widgets#5']);
  writeConfig(repo.root, { ignoreMainCheckout: true });
  writeConfig(wt, { ignoreMainCheckout: true });
  assert.deepEqual(await signals(inMain), []);
  assert.deepEqual(await signals(fileTool('Edit', join(wt, 'src', 'a.ts'))), [W12]);
});

test('ignorePaths from the worktree config skip matching files only', async (t) => {
  const { wt } = widgetsRepo(t);
  writeConfig(wt, { ignorePaths: ['docs/'] });
  assert.deepEqual(await signals(fileTool('Write', join(wt, 'docs', 'a.md'))), []);
  assert.deepEqual(await signals(fileTool('Write', join(wt, 'docs-site', 'a.md'))), [W12]);
  assert.deepEqual(await signals(fileTool('Write', join(wt, 'src', 'a.ts'))), [W12]);
});

test('the worktree config can replace the branch pattern', async (t) => {
  const { repo } = widgetsRepo(t);
  const custom = addWorktree(repo, 'wt-45', 'issue-45');
  assert.deepEqual(await signals(fileTool('Edit', join(custom, 'a.ts'))), []);
  writeConfig(custom, { branchIssuePattern: '^issue-(\\d+)$' });
  assert.deepEqual(await signals(fileTool('Edit', join(custom, 'a.ts'))), ['branch:github.com/acme/widgets#45']);
});

test('absolute paths inside a Bash command bind through their worktree', async (t) => {
  const { repo, wt } = widgetsRepo(t);
  const x = quoted(join(wt, 'src', 'x.ts'));
  for (const command of [`sed -i.bak s/a/b/ ${x}`, `echo hi > ${quoted(join(wt, 'out.txt'))}`, `cp a --target-directory=${quoted(join(wt, 'src'))}`]) {
    assert.deepEqual(await signals(bash(command, repo.root)), [W12], command);
  }
  assert.deepEqual(await signals(bash('ls /tmp', wt)), []);
  assert.deepEqual(await signals(bash(`cat ${x} | grep x`, repo.root)), [W12]);
});

test('tools that do not write files, and unresolvable relative paths, bind nothing', async (t) => {
  const { wt } = widgetsRepo(t);
  assert.deepEqual(await signals(fileTool('Read', join(wt, 'a.ts'))), []);
  assert.deepEqual(await signals({ session_id: SESSION, tool_name: 'Bash', tool_input: { file_path: join(wt, 'a.ts') } }), []);
  assert.deepEqual(await signals(fileTool('Edit', 'src/a.ts')), []);
  assert.deepEqual(await signals(fileTool('Edit', 'src/a.ts', wt)), [W12]);
});

test('untrack on a branch-bound issue survives the next edits in its worktree until a track', async (t) => {
  const { wt } = widgetsRepo(t);
  const paths = pathsFor(tempDir(t));
  let ts = Date.now();
  // The real hook path, one call per payload: extract, then one registry line.
  const hook = async (payload: HookPayload) => {
    const { ev, binds, unbinds } = await extract(payload);
    assert.ok((await appendRegistryLine(paths, SESSION, { v: 1, ts: (ts += 1), ev, binds, unbinds })).ok);
    return (await readSession(paths, SESSION))!.bindings.map((b) => `${b.via}:${refKey(b.ref)}`);
  };
  assert.deepEqual(await hook(fileTool('Edit', join(wt, 'a.ts'))), [W12]);
  assert.deepEqual(await hook(bash('epic-pulse untrack 12', wt)), []);
  assert.deepEqual(await hook(fileTool('Edit', join(wt, 'a.ts'))), []);
  assert.deepEqual(await hook(fileTool('Write', join(wt, 'b.ts'))), []);
  assert.deepEqual(await hook(bash('epic-pulse track 12', wt)), ['pin:github.com/acme/widgets#12']);
  assert.deepEqual(await hook(fileTool('Edit', join(wt, 'a.ts'))), ['pin:github.com/acme/widgets#12']);
});

test('SessionStart and SessionEnd carry their event and no signals', async (t) => {
  const { wt } = widgetsRepo(t);
  const edit = fileTool('Edit', join(wt, 'a.ts'));
  assert.deepEqual(await extract({ ...edit, hook_event_name: 'SessionStart' }), { ev: 'start', binds: [], unbinds: [] });
  assert.deepEqual(await extract({ ...edit, hook_event_name: 'SessionEnd' }), { ev: 'end', binds: [], unbinds: [] });
  assert.equal((await extract(edit)).ev, 'tool');
});
