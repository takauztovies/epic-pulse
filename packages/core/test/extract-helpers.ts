import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { extract } from '../src/extract.js';
import { refKey } from '../src/ref.js';
import type { HookPayload } from '../src/schemas/hook.js';
import { addWorktree, git, makeRepo, type TestRepo } from './repo-helpers.js';

export const SESSION = '0f8e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

export interface Fixture {
  readonly repo: TestRepo;
  readonly wt: string;
}

// `<base>/main` on `main` plus a linked worktree on `fix/12-login`, origin
// github.com/Acme/Widgets.
export function widgetsRepo(t: TestContext, mainBranch = 'main'): Fixture {
  const repo = makeRepo(t, mainBranch);
  git(repo.root, ['remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git']);
  return { repo, wt: addWorktree(repo, 'wt-12', 'fix/12-login') };
}

export function writeConfig(root: string, config: unknown): void {
  writeFileSync(join(root, '.epic-pulse.json'), JSON.stringify(config));
}

// Single quotes keep a Windows path's backslashes literal inside a command.
export const quoted = (path: string): string => `'${path}'`;

export function bash(command: string, cwd: string): HookPayload {
  return { session_id: SESSION, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } };
}

export function fileTool(tool: string, path: string, cwd?: string): HookPayload {
  const input = tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
  return { session_id: SESSION, cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input };
}

// `via:host/owner/repo#n` per bind, `-host/owner/repo#n` per unbind.
export async function signals(payload: HookPayload): Promise<readonly string[]> {
  const extracted = await extract(payload);
  return [...extracted.binds.map((b) => `${b.via}:${refKey(b.ref)}`), ...extracted.unbinds.map((ref) => `-${refKey(ref)}`)];
}
