import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { cliEnv, git, ROOT, runCli, sandbox, SESSION, tempDir, type CliRun, type Sandbox } from './helpers.js';

// A real repository, a sandboxed home and every place epic-pulse could write
// to, so the privacy tests can list exactly what a run left behind.

export interface Scene {
  readonly repo: string;
  readonly box: Sandbox;
  readonly env: NodeJS.ProcessEnv;
  // Where documented files live, most specific first, as the README names them.
  readonly roots: readonly (readonly [string, string])[];
  // Everything to search: the sandbox (home, temp dir, PATH) and the repository.
  readonly everywhere: readonly string[];
}

// The cache root the README names for this platform, inside the sandboxed home.
function cacheRoot(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches');
  return process.platform === 'win32' ? join(home, 'AppData', 'Local') : join(home, '.cache');
}

// The temp directory and the cache variables point into the sandbox too, so
// nothing can land outside what the tests look at.
export function scene(t: TestContext, remote: string, extra: NodeJS.ProcessEnv = {}): Scene {
  const repo = join(tempDir(t, 'ep-privacy-'), 'main');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(repo, ['remote', 'add', 'origin', remote]);
  const box = sandbox(t);
  const tmp = join(dirname(box.home), 'tmp');
  mkdirSync(tmp);
  const caches = { XDG_CACHE_HOME: join(box.home, '.cache'), LOCALAPPDATA: join(box.home, 'AppData', 'Local') };
  const env = cliEnv(box, { ...caches, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...extra });
  const roots = [[box.config, '<claude-config-dir>'], [cacheRoot(box.home), '<user-cache-dir>'], [join(repo, '.git'), '<git-common-dir>']] as const;
  return { repo, box, env, roots, everywhere: [dirname(box.home), dirname(repo)] };
}

export function run(where: Scene, args: readonly string[], input?: string): Promise<CliRun> {
  return runCli(args, { cwd: where.repo, env: where.env, input });
}

function filesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

// Every file of the scene with a hash of its bytes.
export function inventory(where: Scene): ReadonlyMap<string, string> {
  const files = where.everywhere.flatMap((dir) => filesUnder(dir));
  return new Map(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
}

export function filesContaining(where: Scene, needle: string): readonly string[] {
  return where.everywhere.flatMap((dir) => filesUnder(dir)).filter((file) => readFileSync(file).includes(needle));
}

// A path as the README writes it: `<git-common-dir>/epic-pulse/...`. A file
// outside every documented place keeps its full path, which no entry matches.
export function documentedForm(where: Scene, file: string): string {
  const root = where.roots.find(([dir]) => file.startsWith(`${dir}${sep}`));
  const shown = root ? `${root[1]}/${relative(root[0], file)}` : file;
  return shown.replace(/\\/g, '/').replaceAll(SESSION, '<session-id>');
}

// The README's own list, the first text block under "Files it writes".
// Windows checkouts may turn its line ends into CRLF.
export function documentedFiles(): readonly string[] {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = readme.split('\n### Files it writes\n')[1] ?? '';
  const block = /```text\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
  return block.split('\n').map((line) => line.trim()).filter(Boolean);
}
