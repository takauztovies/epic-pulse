import { execFile } from 'node:child_process';
import { resolve, type PlatformPath } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PorcelainWorktree {
  readonly path: string;
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly isMain: boolean;
}

// `git worktree list --porcelain`: blocks separated by a blank line, the first
// block being the main worktree. Keys: worktree, HEAD, branch, detached, bare,
// locked, prunable. Git for Windows writes C:/Users/x/repo where every other
// path here, findWorktree's included, is C:\Users\x\repo, so each path is
// resolved the way the platform spells it. `paths` is only there for a test to
// read the Windows output on another platform.
export function parseWorktreePorcelain(text: string, paths: Pick<PlatformPath, 'resolve'> = { resolve }): readonly PorcelainWorktree[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.some((line) => line.startsWith('worktree ')))
    .map((lines, index) => ({
      path: paths.resolve(lines.find((l) => l.startsWith('worktree '))!.slice('worktree '.length)),
      branch: /^branch refs\/heads\/(.+)$/.exec(lines.find((l) => l.startsWith('branch ')) ?? '')?.[1],
      detached: lines.includes('detached'),
      bare: lines.includes('bare'),
      isMain: index === 0,
    }));
}

// GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ...) are exported by git hooks and
// would silently redirect this command to the repository that is running the
// hook instead of the one we were asked about.
function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}

export async function listWorktrees(cwd: string, env: NodeJS.ProcessEnv): Promise<readonly PorcelainWorktree[]> {
  const { stdout } = await run('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
    env: cleanEnv(env),
    timeout: 10_000,
    windowsHide: true,
  });
  return parseWorktreePorcelain(stdout);
}
