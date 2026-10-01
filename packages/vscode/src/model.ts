import type { ErrorCode, JsonEpic, StateKind } from '@epic-pulse/core';
import { mergeEpics } from './merge.js';
import type { RepoResult } from './poll.js';

// Core's states, plus the one only an editor can offer a way out of.
export type DisplayState = StateKind | 'signed-out';

// Everything the tree, the status bar and the details view are drawn from:
// every workspace repository's view, folded into one.
export interface Model {
  readonly state: DisplayState;
  // The code behind an error, stale or signed-out state. Never a message.
  readonly error: ErrorCode | null;
  readonly epics: readonly JsonEpic[];
  readonly liveSessions: number;
  // The newest snapshot write across the repositories, as ISO 8601.
  readonly fetchedAt: string | null;
  readonly repoCount: number;
  readonly now: number;
}

export interface ModelInput {
  readonly results: readonly RepoResult[];
  readonly now: number;
}

// The failures that signing in to GitHub would cure.
const TOKEN_ERRORS: ReadonlySet<ErrorCode> = new Set(['no_token', 'unauthorized', 'invalid_token']);

// With nothing to show, the most telling state wins: a failure, then a host
// that can not work, then waiting, then "no epic" from a working hook, and
// last a repository the hook has never written to.
const NO_DATA_ORDER: readonly StateKind[] = ['error', 'unsupported', 'loading', 'none', 'hook-inactive'];

// The unscoped view never says hook-inactive (that is a statement about one
// session); for a whole repository it means no session file at all.
export function repoState(result: RepoResult): StateKind {
  const { state } = result.view.snapshot;
  return state === 'none' && !result.hookSeen ? 'hook-inactive' : state;
}

// A refresh that had no VS Code token to use failed for want of a token.
// With a sign-in in use the same code is an error instead: signing in again is
// not obviously the cure, and the code says what went wrong.
function isSignedOut(result: RepoResult): boolean {
  const { state, error } = result.view.snapshot;
  return result.token === 'none' && (state === 'error' || state === 'stale') && error !== null && TOKEN_ERRORS.has(error);
}

// Data wins over errors, as in core's own view: anything fetched is shown,
// stale if any of it is.
function baseState(results: readonly RepoResult[], epics: readonly JsonEpic[]): StateKind {
  if (epics.length > 0) return epics.some((epic) => epic.stale) ? 'stale' : 'ok';
  const states = new Set(results.map(repoState));
  return NO_DATA_ORDER.find((state) => states.has(state)) ?? 'none';
}

function errorOf(results: readonly RepoResult[], match: (result: RepoResult) => boolean): ErrorCode | null {
  return results.filter(match).map((result) => result.view.snapshot.error).find((error) => error !== null) ?? null;
}

// The code comes from a repository in the state shown, so an "ok" next to
// another repository's failure carries none.
function stateError(results: readonly RepoResult[], state: DisplayState): ErrorCode | null {
  if (state === 'ok') return null;
  if (state === 'signed-out') return errorOf(results, isSignedOut);
  return errorOf(results, (result) => repoState(result) === state);
}

function newestFetch(results: readonly RepoResult[]): string | null {
  const times = results.flatMap((result) => (result.view.snapshot.fetchedAt === null ? [] : [result.view.snapshot.fetchedAt]));
  return times.reduce<string | null>((best, time) => (best === null || Date.parse(time) > Date.parse(best) ? time : best), null);
}

export function buildModel(input: ModelInput): Model {
  const { results } = input;
  const epics = mergeEpics(results.map((result) => result.view));
  const state = results.some(isSignedOut) ? 'signed-out' : baseState(results, epics);
  return {
    state,
    error: stateError(results, state),
    epics,
    liveSessions: results.reduce((sum, result) => sum + result.view.liveSessions, 0),
    fetchedAt: newestFetch(results),
    repoCount: results.length,
    now: input.now,
  };
}
