import { readdir, stat } from 'node:fs/promises';
import {
  buildView, gatherRefs, loadProgressFor, pathsFor, pinsOf, readLiveSessions, readPins, readSnapshot, refresh,
  type JsonV1, type RefreshOutcome, type RegistryPaths,
} from '@epic-pulse/core';
import { tokenUse, type Grant, type TokenUse } from './grant.js';
import type { RepoTarget } from './repos.js';

// `skipped`: the registry does not exist, so nothing was refreshed. `failed`:
// the registry could not be written. The rest are core's own outcomes.
export type RefreshSummary = RefreshOutcome | { readonly status: 'skipped' } | { readonly status: 'failed' };

// What the files of one registry say after the refresh.
export interface RepoState {
  readonly view: JsonV1;
  readonly hookSeen: boolean;
}

export interface RepoResult extends RepoState {
  readonly repo: RepoTarget;
  readonly refresh: RefreshSummary;
  readonly token: TokenUse;
  // The hosts the registry names, which the Sign in action has to serve.
  readonly hosts: readonly string[];
}

export interface PollOptions {
  readonly now: number;
  readonly env: NodeJS.ProcessEnv;
  readonly grant: Grant;
}

const SESSION_SUFFIX = '.jsonl';

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

// The hook writes a session's file when the session starts, and files live a
// week, so a registry without one has not heard from the hook all week: the
// plugin is not enabled here, or there is no Node to run it.
async function hookSeen(paths: RegistryPaths): Promise<boolean> {
  const names = await readdir(paths.sessionsDir).catch(() => [] as string[]);
  return names.some((name) => name.endsWith(SESSION_SUFFIX));
}

// Files only, nothing fetched: the unscoped view `epic-pulse json` prints,
// covering every live session of the repository and its pins.
export async function inspectRepo(repo: RepoTarget, now: number): Promise<RepoState> {
  const paths = pathsFor(repo.dir);
  const [sessions, snapshot, pins, seen, progress] = await Promise.all([
    readLiveSessions(paths, now), readSnapshot(paths.snapshotFile), readPins(paths), hookSeen(paths), loadProgressFor(repo.folder),
  ]);
  return { view: buildView({ snapshot, sessions, pins: pinsOf(pins), now, progress }), hookSeen: seen };
}

// Every host the refresh could contact: those of the issues it keeps current.
// Epics are fetched from their issue's host, so they add none.
async function registryHosts(paths: RegistryPaths, now: number): Promise<ReadonlySet<string>> {
  const [sessions, pins] = await Promise.all([readLiveSessions(paths, now), readPins(paths)]);
  return new Set(gatherRefs(sessions, pinsOf(pins), now).map((ref) => ref.host));
}

// `refresh` throws only when the registry can not be written. That is reported
// as `failed`, and the view is still read from what is there. The grant goes
// to core as it is, keyed by host: core offers each token to its own host
// only, so another host in the registry needs no special case.
async function runRefresh(dir: string, options: PollOptions): Promise<Pick<RepoResult, 'refresh' | 'token' | 'hosts'>> {
  const hosts = await registryHosts(pathsFor(dir), options.now);
  const named = { token: tokenUse(options.grant, hosts), hosts: [...hosts] };
  try {
    return { refresh: await refresh({ dir, now: options.now, env: options.env, tokens: options.grant }), ...named };
  } catch {
    return { refresh: { status: 'failed' }, ...named };
  }
}

// A registry that does not exist yet is read, never refreshed: a refresh takes
// a lock inside it, which would create `.git/epic-pulse/` in every repository
// the editor opens, including those that never use epic-pulse.
export async function pollRepo(repo: RepoTarget, options: PollOptions): Promise<RepoResult> {
  const skipped = { refresh: { status: 'skipped' }, token: 'none', hosts: [] } as const;
  const ran = (await isDirectory(repo.dir)) ? await runRefresh(repo.dir, options) : skipped;
  return { repo, ...ran, ...(await inspectRepo(repo, options.now)) };
}

export function pollAll(repos: readonly RepoTarget[], options: PollOptions): Promise<readonly RepoResult[]> {
  return Promise.all(repos.map((repo) => pollRepo(repo, options)));
}

// What a window without focus does on each tick: the repositories of the last
// poll, read again from their files alone. Nothing is fetched, no lock is taken
// and nothing is written, so what the window shows ages honestly (fresh data
// turns stale on screen) and picks up what a hook or another refresher wrote,
// at no cost to the hourly budget. The last refresh, its token and its hosts
// are what that poll found, and change only when a refresh runs. A repository
// the last poll did not find waits for the next one, which opening a folder or
// coming back to the window runs at once.
export function readAll(previous: readonly RepoResult[], now: number): Promise<readonly RepoResult[]> {
  return Promise.all(previous.map(async (result) => ({ ...result, ...(await inspectRepo(result.repo, now)) })));
}
