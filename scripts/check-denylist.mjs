// Fails when a word on the denylist appears anywhere this repository ships:
// names that must never reach a public repository. The list holds SHA-256
// digests, so it does not publish the names itself.
//
//   node scripts/check-denylist.mjs
//
// Reads every tracked text file of the repository it runs in, the fixtures
// among them, and every file the builds write into dist/, splits each into
// lowercase [a-z0-9]+ words and hashes each word. A hit prints the file, the
// line and the digest's start, never the word. Exit 0 clean, 1 a listed word
// was found, 2 the denylist has a line that is not a digest.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { URL } from 'node:url';

const DENYLIST = new URL('denylist.sha256', import.meta.url);
const BUILT = ['packages/cli/dist', 'plugin/dist', 'packages/vscode/dist'];
const DIGEST = /^[0-9a-f]{64}$/;
// Git's own test for binary content: a NUL in the first 8000 bytes.
const SNIFF_BYTES = 8000;

// One digest per line; `#` starts a comment. A line that is neither is a typo
// that would never match anything, so it is refused, not skipped.
function readDenylist() {
  const rows = readFileSync(DENYLIST, 'utf8').split(/\r?\n/).map((line, i) => [i + 1, line.replace(/#.*/, '').trim().toLowerCase()]);
  const bad = rows.filter(([, entry]) => entry !== '' && !DIGEST.test(entry)).map(([n]) => n);
  if (bad.length > 0) return { error: `scripts/denylist.sha256 line ${bad.join(', ')}: not a SHA-256 hex digest` };
  return { digests: new Set(rows.map(([, entry]) => entry).filter(Boolean)) };
}

// Slash-separated like git's own paths, on Windows too.
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function filesToRead() {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set([...tracked, ...BUILT.flatMap(filesUnder)])].filter((file) => existsSync(file) && statSync(file).isFile());
}

// Every word of a text file whose digest is listed, as `file:line`.
function hitsIn(file, listed, memo) {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return [];
  return bytes.toString('utf8').toLowerCase().split('\n').flatMap((line, i) => {
    const words = line.match(/[a-z0-9]+/g) ?? [];
    const digests = words.map((word) => memo.get(word) ?? memo.set(word, createHash('sha256').update(word).digest('hex')).get(word));
    return digests.filter((digest) => listed.has(digest)).map((digest) => `${file}:${i + 1} holds a denylisted word (sha256 ${digest.slice(0, 12)}...)`);
  });
}

function check() {
  const list = readDenylist();
  if (list.error) return { code: 2, out: [`epic-pulse: ${list.error}`] };
  const files = filesToRead();
  const memo = new Map();
  const hits = files.flatMap((file) => hitsIn(file, list.digests, memo));
  if (hits.length > 0) return { code: 1, out: hits.map((hit) => `epic-pulse: ${hit}`) };
  return { code: 0, out: [`epic-pulse: no denylisted word in ${files.length} files.`] };
}

const { code, out } = check();
console.log(out.join('\n'));
process.exitCode = code;
