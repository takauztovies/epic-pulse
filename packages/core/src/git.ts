import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RepoRefSchema, type RepoRef } from './schemas/common.js';

export interface WorktreeInfo {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly isMain: boolean;
}

const MAX_GIT_FILE_BYTES = 64 * 1024;

async function readSmall(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > MAX_GIT_FILE_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

// A worktree's private git dir points at the shared one through `commondir`.
// Without that file (a normal checkout, a submodule) the git dir is its own
// common dir.
async function commonDirOf(gitDir: string): Promise<string> {
  const pointer = (await readSmall(join(gitDir, 'commondir')))?.trim();
  return pointer ? resolve(gitDir, pointer) : gitDir;
}

async function inspect(dir: string): Promise<WorktreeInfo | undefined> {
  const marker = join(dir, '.git');
  const entry = await lstat(marker).catch(() => undefined);
  if (!entry) return undefined;
  let gitDir = marker;
  if (entry.isFile()) {
    const target = /^gitdir:\s*(.+?)\s*$/m.exec((await readSmall(marker)) ?? '')?.[1];
    if (!target) return undefined;
    gitDir = resolve(dir, target);
  }
  const commonDir = await commonDirOf(gitDir);
  return { root: dir, gitDir, commonDir, isMain: resolve(gitDir) === resolve(commonDir) };
}

// The directory to start the upward search from: the path itself when it is a
// directory, its parent when it is a file, and the nearest existing ancestor
// when it does not exist yet.
async function startDirectory(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    const info = await stat(current).catch(() => undefined);
    if (info) return info.isDirectory() ? current : dirname(current);
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

// Pure file reads, no `git` process: the hook has a 50ms budget and Windows
// process spawn alone can eat most of it. A path that does not exist yet (a file
// just written) is looked up from its nearest existing parent.
export async function findWorktree(start: string): Promise<WorktreeInfo | undefined> {
  let dir = await startDirectory(start);
  for (;;) {
    const info = await inspect(dir);
    if (info) return info;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Detached HEAD (and any HEAD we can not read) has no branch.
export async function readBranch(info: Pick<WorktreeInfo, 'gitDir'>): Promise<string | undefined> {
  const head = await readSmall(join(info.gitDir, 'HEAD'));
  return /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head ?? '')?.[1];
}

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(\S+)$/; // 2+ chars so `C:\repo` is not a host
const URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);

function splitUrl(text: string): { host: string; path: string } | undefined {
  const scp = SCP_LIKE.exec(text);
  if (scp) return { host: scp[1]!, path: scp[2]! };
  try {
    const url = new URL(text);
    if (!URL_PROTOCOLS.has(url.protocol)) return undefined;
    // An ssh port is not an API port; only http(s) remotes keep theirs.
    const host = url.protocol.startsWith('http') ? url.host : url.hostname;
    return { host, path: decodeURIComponent(url.pathname) };
  } catch {
    return undefined;
  }
}

// Credentials in a remote (`https://user:token@host/...`) are dropped here and
// never stored. The last two path segments are owner and repo.
export function parseRemoteUrl(url: string): RepoRef | undefined {
  const parts = splitUrl(url.trim());
  if (!parts) return undefined;
  const segments = parts.path.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
  const [owner, repo] = segments.slice(-2);
  if (!owner || !repo || segments.length < 2) return undefined;
  const parsed = RepoRefSchema.safeParse({ host: parts.host.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase() });
  return parsed.success ? parsed.data : undefined;
}

// `origin` when present, otherwise the first remote in the file.
export async function readRemote(commonDir: string): Promise<RepoRef | undefined> {
  const config = (await readSmall(join(commonDir, 'config'))) ?? '';
  const urls = new Map<string, string>();
  let section: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[(.*)\]\s*$/.exec(line);
    if (header) section = /^remote\s+"([^"]+)"$/.exec(header[1]!.trim())?.[1];
    const value = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1];
    if (section && value && !urls.has(section)) urls.set(section, value);
  }
  const chosen = urls.get('origin') ?? [...urls.values()][0];
  return chosen ? parseRemoteUrl(chosen) : undefined;
}
