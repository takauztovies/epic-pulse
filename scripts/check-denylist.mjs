// Fails when a word on the denylist appears anywhere this repository ships:
// names that must never reach a public repository. The list holds HMAC-SHA256
// digests under a secret key, so it does not publish the names, and a
// dictionary of guesses can not be run against it as it could against plain
// hashes of short words.
//
//   node scripts/check-denylist.mjs
//
// The key is the environment variable EPIC_PULSE_DENYLIST_KEY, else the file
// ~/.config/epic-pulse/denylist.key (mode 0600). Without one the check prints
// "denylist: skipped (no key)" and exits 0, as it must for a contributor or a
// fork that was never given the key, unless CI ran it on this repository's own
// push or pull request, which have the secret: there a missing key is a mistake
// and fails the check, so that it can not go quietly unchecked.
//
// Reads every tracked text file of the repository it runs in, the fixtures
// among them, and every file the builds write into dist/, splits each into
// lowercase [a-z0-9]+ words and takes the HMAC of each word. A hit prints the
// file, the line and the digest's start, never the word. Exit 0 clean or
// skipped, 1 a listed word was found, 2 the check could not run: the list has a
// line that is not a digest, the key file can not be read, or CI has no key.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

const DENYLIST = new URL('denylist.hmac', import.meta.url);
const KEY_VARIABLE = 'EPIC_PULSE_DENYLIST_KEY';
const BUILT = ['packages/cli/dist', 'plugin/dist', 'packages/vscode/dist'];
const DIGEST = /^[0-9a-f]{64}$/;
// Git's own test for binary content: a NUL in the first 8000 bytes.
const SNIFF_BYTES = 8000;

// One digest per line; `#` starts a comment. A line that is neither is a typo
// that would never match anything, so it is refused, not skipped.
function readDenylist() {
  const rows = readFileSync(DENYLIST, 'utf8').split(/\r?\n/).map((line, i) => [i + 1, line.replace(/#.*/, '').trim().toLowerCase()]);
  const bad = rows.filter(([, entry]) => entry !== '' && !DIGEST.test(entry)).map(([n]) => n);
  if (bad.length > 0) return { error: `scripts/denylist.hmac line ${bad.join(', ')}: not an HMAC-SHA256 hex digest` };
  return { digests: new Set(rows.map(([, entry]) => entry).filter(Boolean)) };
}

function keyFile() {
  try {
    return join(homedir(), '.config', 'epic-pulse', 'denylist.key');
  } catch {
    return undefined; // no HOME and no passwd entry, e.g. an unnamed container user
  }
}

// The environment first, as CI supplies it, then the file a maintainer keeps.
// Surrounding whitespace is not part of the key: `echo key > file` writes a
// newline and a pasted secret may carry one, while the recipe in the list's
// header takes the key from a variable, which has none. A key that differs
// matches nothing and the check passes, so that is the one slip worth removing.
function readKey(env) {
  const fromEnv = (env[KEY_VARIABLE] ?? '').trim();
  const file = keyFile();
  if (fromEnv !== '' || file === undefined) return { key: fromEnv };
  try {
    return { key: readFileSync(file, 'utf8').trim() };
  } catch (error) {
    return error.code === 'ENOENT' ? { key: '' } : { error: `${file} can not be read (${error.code})` };
  }
}

// CI hands this repository's own runs its secrets: a push, or a pull request
// from one of its own branches (HEAD_REPO, which the workflow sets). A key
// missing there is a mistake, the secret never set or named wrongly, and a check
// that skips on a mistake guards nothing. Only a pull request from a fork has no
// secrets, and may go without. A pull request whose head repository is not
// given is not known to be a fork, so it counts as one of ours.
function keyRequired(env) {
  if (env.GITHUB_ACTIONS !== 'true') return false;
  const fork = env.GITHUB_EVENT_NAME === 'pull_request' && Boolean(env.HEAD_REPO) && env.HEAD_REPO !== env.GITHUB_REPOSITORY;
  return !fork;
}

function withoutKey(env) {
  if (!keyRequired(env)) return { code: 0, out: ['denylist: skipped (no key)'] };
  const repository = env.GITHUB_REPOSITORY ?? 'this repository';
  return { code: 2, out: [`::error::denylist: no key on a run of ${repository}. CI gives its own runs the DENYLIST_KEY secret; set it, or this check guards nothing.`] };
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

// One HMAC per distinct word: the files repeat the same few thousand words.
function digester(key) {
  const memo = new Map();
  return (word) => {
    if (!memo.has(word)) memo.set(word, createHmac('sha256', key).update(word).digest('hex'));
    return memo.get(word);
  };
}

// Every word of a text file whose digest is listed, as `file:line`.
function hitsIn(file, listed, digestOf) {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return [];
  return bytes.toString('utf8').toLowerCase().split('\n').flatMap((line, i) => {
    const digests = (line.match(/[a-z0-9]+/g) ?? []).map(digestOf);
    return digests.filter((digest) => listed.has(digest)).map((digest) => `${file}:${i + 1} holds a denylisted word (hmac ${digest.slice(0, 12)}...)`);
  });
}

function check(env) {
  const list = readDenylist();
  if (list.error) return { code: 2, out: [`epic-pulse: ${list.error}`] };
  const found = readKey(env);
  if (found.error) return { code: 2, out: [`epic-pulse: ${found.error}`] };
  if (found.key === '') return withoutKey(env);
  const files = filesToRead();
  const digestOf = digester(found.key);
  const hits = files.flatMap((file) => hitsIn(file, list.digests, digestOf));
  if (hits.length > 0) return { code: 1, out: hits.map((hit) => `epic-pulse: ${hit}`) };
  return { code: 0, out: [`epic-pulse: no denylisted word in ${files.length} files.`] };
}

const { code, out } = check(process.env);
console.log(out.join('\n'));
process.exitCode = code;
