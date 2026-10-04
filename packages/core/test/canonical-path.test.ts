import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { canonicalPath } from '../src/canonical-path.js';
import { findWorktree } from '../src/git.js';
import { registryDirFor } from '../src/paths.js';
import { addWorktree, linkTo, makeRepo, tempDir } from './repo-helpers.js';

// One directory, two spellings: on a Windows runner os.tmpdir() says
// C:\Users\RUNNER~1\... where git writes C:\Users\runneradmin\..., on macOS
// /var/folders/... where git writes /private/var/folders/.... A string is what
// the registry and the VS Code view tell repositories apart by, so two
// spellings were two repositories. A link is the same case on every platform.

test('a path reached through a link has the real spelling, whether or not its tail exists yet', async (t) => {
  const real = tempDir(t);
  mkdirSync(join(real, 'a'));
  const link = linkTo(t, real);
  assert.equal(await canonicalPath(link), real);
  assert.equal(await canonicalPath(join(link, 'a')), join(real, 'a'));
  assert.equal(await canonicalPath(join(link, 'a', 'not-yet', 'x.ts')), join(real, 'a', 'not-yet', 'x.ts'));
});

test('a path whose only existing ancestor is the root keeps its own spelling', async () => {
  const nowhere = join(parse(process.cwd()).root, 'ep-no-such-dir-for-canonical-path', 'x', 'y.ts');
  assert.equal(await canonicalPath(nowhere), nowhere);
});

test('a repository reached through a link is the same worktree as through its real path', async (t) => {
  const repo = makeRepo(t);
  const link = linkTo(t, repo.root);
  const direct = await findWorktree(repo.root);
  const through = await findWorktree(join(link, 'src', 'x.ts'));
  assert.equal(direct?.commonDir, join(repo.root, '.git'));
  assert.equal(through?.gitDir, direct?.gitDir);
  assert.equal(through?.commonDir, direct?.commonDir);
  assert.equal(through?.isMain, true);
});

test('the main checkout through a link and a linked worktree share one registry directory', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-one', 'fix/123-thing');
  const viaLink = await registryDirFor(linkTo(t, repo.root), {});
  assert.equal(viaLink, join(repo.root, '.git', 'epic-pulse'));
  assert.equal(await registryDirFor(wt, {}), viaLink);
});

test('a registry directory named by EPIC_PULSE_DIR has the real spelling too, before it exists', async (t) => {
  const real = tempDir(t);
  const link = linkTo(t, real);
  assert.equal(await registryDirFor(real, { EPIC_PULSE_DIR: join(link, 'registry') }), join(real, 'registry'));
});

// git accepts an absolute `commondir` as well as the usual `../..`.
test('a worktree whose commondir names the common dir through a link still reports the real one', async (t) => {
  const repo = makeRepo(t);
  const wt = addWorktree(repo, 'wt-one', 'fix/123-thing');
  const link = linkTo(t, repo.root);
  writeFileSync(join(repo.root, '.git', 'worktrees', 'wt-one', 'commondir'), `${join(link, '.git')}\n`);
  const info = await findWorktree(wt);
  assert.equal(info?.commonDir, join(repo.root, '.git'));
  assert.equal(info?.isMain, false);
});
