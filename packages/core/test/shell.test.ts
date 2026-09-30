import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseShell } from '../src/shell.js';

const words = (src: string) => parseShell(src).commands.map((c) => c.words);

test('operators and newlines separate simple commands', () => {
  assert.deepEqual(words('a b && c; d | e & f\ng || h |& i (j) k'), [['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i'], ['j'], ['k']]);
});

test('quotes and escapes are removed, and quoted text stays inside its word', () => {
  assert.deepEqual(words(`gh issue comment 5 --body "it's #7" 'a "b"' a\\ b`), [['gh', 'issue', 'comment', '5', '--body', "it's #7", 'a "b"', 'a b']]);
  assert.deepEqual(words('echo "gh issue close 5; gh issue close 6"'), [['echo', 'gh issue close 5; gh issue close 6']]);
  assert.deepEqual(words('echo "a\\"b\\$c\\x"'), [['echo', 'a"b$c\\x']]);
  assert.deepEqual(words('gh issue \\\ncomment 5'), [['gh', 'issue', 'comment', '5']]);
});

test('a # at the start of a word is a comment, inside a word it is text', () => {
  assert.deepEqual(words('gh issue close #5'), [['gh', 'issue', 'close']]);
  assert.deepEqual(words('echo a#b # trailing words\nnext'), [['echo', 'a#b'], ['next']]);
});

test('redirections are not arguments; their targets are kept apart', () => {
  const [command] = parseShell('gh issue comment 5 --body x 2>&1 > /tmp/out 2>>/tmp/err &>/tmp/both >&2 < in <<< "here"').commands;
  assert.deepEqual(command?.words, ['gh', 'issue', 'comment', '5', '--body', 'x']);
  assert.deepEqual(command?.targets, ['/tmp/out', '/tmp/err', '/tmp/both', 'in', 'here']);
  assert.deepEqual(words('echo "2">x'), [['echo', '2']]);
});

test('a heredoc body is data, not commands', () => {
  const src = "cat > /wt/f.sh <<'EOF'\ngh issue close 7\nEOF\ngh issue comment 5\ncat <<-END\n\tgh issue close 8\n\tEND\ndone";
  assert.deepEqual(words(src), [['cat'], ['gh', 'issue', 'comment', '5'], ['cat'], ['done']]);
});

test('a heredoc inside $( ) in a quoted argument stays in that argument, apostrophes and all', () => {
  const src = `git commit -m "$(cat <<'EOF'\nfeat: it's done (finally)\n\nFixes #5\nEOF\n)" && echo ok`;
  const parsed = words(src);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]?.slice(0, 3), ['git', 'commit', '-m']);
  assert.match(parsed[0]?.[3] ?? '', /it's done \(finally\)\n\nFixes #5\nEOF\n\)$/);
  assert.deepEqual(parsed[1], ['echo', 'ok']);
});

test('nested substitutions, backquotes and arithmetic are kept verbatim inside a word', () => {
  assert.deepEqual(words('echo $(echo "a)b") `x ; y` $((1*2))'), [['echo', '$(echo "a)b")', '`x ; y`', '$((1*2))']]);
});

test('unquoted *, ? and [..] are globs; quoted or escaped ones are not', () => {
  for (const src of ['ls /wt/*.ts', 'rm a?.log', 'cat a[0-9]', 'git add src/*.ts && git commit -m "Fixes #6"']) {
    assert.equal(parseShell(src).glob, true, src);
  }
  for (const src of ['echo "*"', "echo '?'", 'echo \\*', 'git commit -m "Fix * handling"', '[ -f x ]', '[[ -n x ]]']) {
    assert.equal(parseShell(src).glob, false, src);
  }
});

test('unterminated quotes and substitutions end at the end of the input instead of looping', () => {
  assert.deepEqual(words('echo "open'), [['echo', 'open']]);
  assert.deepEqual(words("echo 'open"), [['echo', 'open']]);
  assert.deepEqual(words('echo $(open'), [['echo', '$(open']]);
  assert.deepEqual(words('cat <<EOF\nno end'), [['cat']]);
});

test('an oversized command yields nothing rather than a partial parse', () => {
  assert.deepEqual(parseShell(`gh issue comment 5 ${'x'.repeat(300 * 1024)}`), { commands: [], glob: false });
});
