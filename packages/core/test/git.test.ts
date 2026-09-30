import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findWorktree, parseRemoteUrl, readBranch, readRemote } from '../src/git.js';
import { listWorktrees, parseWorktreePorcelain } from '../src/git-cli.js';
import { addWorktree, git, makeRepo, tempDir } from './repo-helpers.js';

test('a normal checkout is the main worktree, found from any depth or from a file that does not exist yet', async (t) => {
  const repo = makeRepo(t);
  mkdirSync(join(repo.root, 'a', 'b'), { recursive: true });
  const expected = { root: repo.root, gitDir: join(repo.root, '.git'), commonDir: join(repo.root, '.git'), isMain: true };
  assert.deepEqual(await findWorktree(repo.root), expected);
  assert.deepEqual(await findWorktree(join(repo.root, 'a', 'b')), expected);
  assert.deepEqual(await findWorktree(join(repo.root, 'a', 'b', 'not-written-yet.ts')), expected);
});

test('a linked worktree shares the main common dir but is not the main checkout', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-one', 'fix/123-thing');
  const info = await findWorktree(join(wt, 'src', 'x.ts'));
  assert.equal(info?.root, wt);
  assert.equal(info?.commonDir, join(repo.root, '.git'));
  assert.equal(info?.isMain, false);
});

test('the branch comes from HEAD; a detached HEAD has none', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-two', 'feat/77-widget');
  assert.equal(await readBranch((await findWorktree(repo.root))!), 'main');
  assert.equal(await readBranch((await findWorktree(wt))!), 'feat/77-widget');
  git(wt, ['checkout', '-q', '--detach']);
  assert.equal(await readBranch((await findWorktree(wt))!), undefined);
});

test('outside any repository there is no worktree', async (t) => {
  assert.equal(await findWorktree(tempDir(t)), undefined);
});

test('the remote is read from the shared config, origin before other names, credentials dropped', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-three', 'fix/5-x');
  assert.equal(await readRemote((await findWorktree(repo.root))!.commonDir), undefined);
  git(repo.root, ['remote', 'add', 'mirror', 'git@github.com:Mirror/Repo.git']);
  git(repo.root, ['remote', 'add', 'origin', 'https://user:secret@github.com/Acme/Widgets.git']);
  const viaWorktree = await readRemote((await findWorktree(wt))!.commonDir);
  assert.deepEqual(viaWorktree, { host: 'github.com', owner: 'acme', repo: 'widgets' });
  assert.ok(!JSON.stringify(viaWorktree).includes('secret'));
});

test('a fork reads its base: the remote gh set as default, then upstream, then origin, then the first', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-fork', 'fix/5-x');
  const owner = async () => (await readRemote((await findWorktree(wt))!.commonDir))?.owner;
  git(repo.root, ['remote', 'add', 'mirror', 'https://github.com/Mirror/Widgets.git']);
  assert.equal(await owner(), 'mirror');
  git(repo.root, ['remote', 'add', 'origin', 'git@github.com:Me/Widgets.git']);
  assert.equal(await owner(), 'me');
  git(repo.root, ['remote', 'add', 'upstream', 'https://github.com/Acme/Widgets.git']);
  assert.equal(await owner(), 'acme');
  git(repo.root, ['config', 'remote.mirror.gh-resolved', 'base']); // what `gh repo set-default` writes
  assert.equal(await owner(), 'mirror');
});

test('remote URL forms', () => {
  const dotcom = { host: 'github.com', owner: 'acme', repo: 'widgets' };
  for (const url of ['https://github.com/acme/widgets', 'https://github.com/acme/widgets.git/', 'git@github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git', 'ssh://git@github.com:22/acme/widgets', 'git://github.com/acme/widgets.git',
    'https://tok:x-oauth-basic@github.com/Acme/Widgets']) {
    assert.deepEqual(parseRemoteUrl(url), dotcom, url);
  }
  assert.deepEqual(parseRemoteUrl('https://ghe.example.com:8443/team/tool.git'), { host: 'ghe.example.com:8443', owner: 'team', repo: 'tool' });
  assert.deepEqual(parseRemoteUrl('git@ghe.example.com:team/tool'), { host: 'ghe.example.com', owner: 'team', repo: 'tool' });
});

test('remote URLs that are not a hosted owner/repo are rejected', () => {
  for (const url of ['', '/srv/git/repo.git', 'file:///srv/git/repo.git', 'C:\\work\\repo', 'C:/work/repo', 'https://github.com/only-owner', 'nonsense', 'ftp://github.com/a/b']) {
    assert.equal(parseRemoteUrl(url), undefined, url);
  }
});

test('the porcelain parser reads path, branch, detached and the main flag', () => {
  const text = 'worktree /r/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt\nHEAD def\ndetached\n\nworktree /r/bare\nbare\n';
  assert.deepEqual(parseWorktreePorcelain(text), [
    { path: '/r/main', branch: 'main', detached: false, bare: false, isMain: true },
    { path: '/r/wt', branch: undefined, detached: true, bare: false, isMain: false },
    { path: '/r/bare', branch: undefined, detached: false, bare: true, isMain: false },
  ]);
});

test('file-based discovery agrees with `git worktree list` for every worktree', async (t) => {
  const repo = makeRepo(t);
  addWorktree(repo, 'wt-a', 'fix/1-a');
  addWorktree(repo, 'wt-b', 'feat/2-b');
  writeFileSync(join(repo.root, 'x.txt'), 'x');
  const listed = await listWorktrees(repo.root, process.env);
  assert.equal(listed.length, 3);
  for (const entry of listed) {
    const info = await findWorktree(entry.path);
    assert.equal(info?.root, entry.path);
    assert.equal(info?.isMain, entry.isMain);
    assert.equal(await readBranch(info), entry.branch);
  }
});
