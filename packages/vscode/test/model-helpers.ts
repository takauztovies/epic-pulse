import { buildModel, type Model } from '../src/model.js';
import { inspectRepo, type RepoResult } from '../src/poll.js';
import type { RepoTarget } from '../src/repos.js';
import { statusBarOf } from '../src/status-model.js';
import { treeOf } from '../src/tree-model.js';

const DONE = { status: 'done', requests: 0, points: 0, error: null } as const;

// The model of real registry files, read through the production path. How the
// last refresh went and where its token came from are the scenario's inputs.
export async function modelOf(repos: readonly RepoTarget[], now: number, token: RepoResult['token'] = 'session'): Promise<Model> {
  const results = await Promise.all(repos.map(async (repo) => ({ repo, refresh: DONE, token, ...(await inspectRepo(repo.dir, now)) })));
  return buildModel({ results, now });
}

// What a user sees first: the state, the notice on top of the tree, and the
// status bar's text.
export function surface(model: Model): readonly unknown[] {
  const [notice] = treeOf(model);
  return [model.state, notice?.kind, notice?.label, notice?.description, statusBarOf(model).text];
}
