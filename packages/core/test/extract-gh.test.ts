import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bash, quoted, signals, widgetsRepo } from './extract-helpers.js';
import { git, makeRepo, tempDir } from './repo-helpers.js';

const W = 'github.com/acme/widgets';

test('every mutating gh issue verb binds its target in the cwd repository', async (t) => {
  const { wt } = widgetsRepo(t);
  for (const verb of ['edit 5 --add-label bug', 'comment 5 --body hi', 'close 5', 'reopen 5 -c back', 'develop 5 --checkout', 'pin 5']) {
    assert.deepEqual(await signals(bash(`gh issue ${verb}`, wt)), [`gh:${W}#5`], verb);
  }
});

test('read-only gh issue commands never bind', async (t) => {
  const { wt } = widgetsRepo(t);
  for (const command of ['gh issue view 5', 'gh issue view 5 --comments', 'gh issue list', 'gh issue list -S 5',
    'gh issue search 5', 'gh issue status', `gh issue view https://github.com/acme/widgets/issues/5`, 'gh issue create -t "Fix #5"']) {
    assert.deepEqual(await signals(bash(command, wt)), [], command);
  }
});

test('-R/--repo and issue URLs name the repository; an unreadable -R binds nothing', async (t) => {
  const { wt } = widgetsRepo(t);
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['gh issue close 7 -R Other/Tools', ['gh:github.com/other/tools#7']],
    ['gh issue comment 7 --repo=ghe.example.com/team/tool -b x', ['gh:ghe.example.com/team/tool#7']],
    ['gh issue -R other/tools edit 7 --add-label bug', ['gh:github.com/other/tools#7']],
    ['gh issue comment 7 -Rother/tools', ['gh:github.com/other/tools#7']],
    ['gh issue comment https://github.com/other/tools/issues/9 -b x', ['gh:github.com/other/tools#9']],
    ['gh issue close 7 -R not-a-repo', []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(await signals(bash(command, wt)), expected, command);
});

test('flag values are never taken for targets', async (t) => {
  const { wt } = widgetsRepo(t);
  for (const command of ['gh issue close 5 --comment 6 --reason "not planned"', 'gh issue close 5 --duplicate-of 6',
    'gh issue comment 5 --body 6 2>&1', 'gh issue edit 5 -m 3 -t "Fix #9"', 'gh issue develop 5 -n 6 -b 7']) {
    assert.deepEqual(await signals(bash(command, wt)), [`gh:${W}#5`], command);
  }
});

test('gh pr create bodies and git commit messages bind their closing keywords', async (t) => {
  const { wt } = widgetsRepo(t);
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['gh pr create --title "Fix #1" --body "Fixes #3"', [`closing:${W}#3`]],
    ['gh pr create -b "Closes #4, resolves acme/widgets#6" -t x', [`closing:${W}#4`, `closing:${W}#6`]],
    ['gh pr create --title "Fixes #1"', []],
    ['git commit -am "Fixes #7"', [`closing:${W}#7`]],
    ['git commit -m "feat: x" -m "Resolves Other/Tools#2"', ['closing:github.com/other/tools#2']],
    ['git commit --message="closes #8" && git commit "-mfixed #9"', [`closing:${W}#8`, `closing:${W}#9`]],
    [`git commit -m "$(cat <<'EOF'\nfeat: it's done\n\nFixes #10\nEOF\n)"`, [`closing:${W}#10`]],
    ['git commit -m "mention #11 only" && gh pr view 3 --body "Fixes #12"', []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(await signals(bash(command, wt)), expected, command);
});

test('git -C and cd point closing keywords at the repository they run in', async (t) => {
  const { wt } = widgetsRepo(t);
  const other = makeRepo(t).root;
  git(other, ['remote', 'add', 'origin', 'git@github.com:Other/Tools.git']);
  const expected = ['closing:github.com/other/tools#2'];
  assert.deepEqual(await signals(bash(`git -C ${quoted(other)} commit -m "Fixes #2"`, wt)), expected);
  assert.deepEqual(await signals(bash(`cd ${quoted(other)} && git commit -m "Fixes #2"`, wt)), expected);
  assert.deepEqual(await signals(bash(`git --git-dir=${quoted(other)}/.git commit -m "Fixes #2"`, wt)), []);
});

test('epic-pulse track pins an issue and untrack unbinds it', async (t) => {
  const { wt } = widgetsRepo(t);
  assert.deepEqual(await signals(bash('epic-pulse track 8', wt)), [`pin:${W}#8`]);
  assert.deepEqual(await signals(bash('epic-pulse untrack 8', wt)), [`-${W}#8`]);
  assert.deepEqual(await signals(bash('epic-pulse untrack #8', wt)), [], 'bash reads #8 as a comment');
  assert.deepEqual(await signals(bash('epic-pulse track other/tools#3', wt)), ['pin:github.com/other/tools#3']);
  assert.deepEqual(await signals(bash('epic-pulse status 8', wt)), []);
});

test('quoted text, comments and heredoc bodies never bind', async (t) => {
  const { wt } = widgetsRepo(t);
  for (const command of ['echo "gh issue close 5"', 'git commit -m "docs: explain gh issue close 5"',
    "cat > /tmp/ep-x.sh <<'EOF'\ngh issue close 5\nEOF", '# gh issue close 5', 'true # gh issue close 5', 'gh issue close #5']) {
    assert.deepEqual(await signals(bash(command, wt)), [], command);
  }
});

test('a command with a glob or with more than three issues binds nothing', async (t) => {
  const { wt } = widgetsRepo(t);
  assert.deepEqual(await signals(bash('git add src/*.ts && git commit -m "Fixes #6"', wt)), []);
  assert.deepEqual(await signals(bash('gh issue edit 1 2 3 4 --add-label x', wt)), []);
  assert.deepEqual(await signals(bash('gh issue close 1 && gh issue close 2 && gh issue close 3 && gh issue close 4', wt)), []);
  assert.deepEqual(await signals(bash('gh issue edit 1 2 3 --add-label x', wt)), [`gh:${W}#1`, `gh:${W}#2`, `gh:${W}#3`]);
});

test('a later action on the same issue wins, except that only a pin undoes an untrack; the strongest via is kept', async (t) => {
  const { wt } = widgetsRepo(t);
  assert.deepEqual(await signals(bash('epic-pulse untrack 5 && gh issue comment 5 -b x', wt)), [`-${W}#5`]);
  assert.deepEqual(await signals(bash('epic-pulse untrack 5 && epic-pulse track 5', wt)), [`pin:${W}#5`]);
  assert.deepEqual(await signals(bash('gh issue comment 5 -b x && epic-pulse untrack 5', wt)), [`-${W}#5`]);
  assert.deepEqual(await signals(bash('gh issue comment 5 -b x && git commit -m "Fixes #5"', wt)), [`gh:${W}#5`]);
});

test('shell keywords before the program do not hide it', async (t) => {
  const { wt } = widgetsRepo(t);
  assert.deepEqual(await signals(bash('if gh issue close 5; then echo done; fi', wt)), [`gh:${W}#5`]);
  assert.deepEqual(await signals(bash('{ gh issue comment 5 -b x; }', wt)), [`gh:${W}#5`]);
});

test('outside a repository only targets that name their own repository bind', async (t) => {
  const outside = tempDir(t);
  assert.deepEqual(await signals(bash('gh issue comment 5 -b x', outside)), []);
  assert.deepEqual(await signals(bash('gh issue comment 5 -b x -R acme/widgets', outside)), [`gh:${W}#5`]);
});
