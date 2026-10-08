import { buildView, loadProgressFor, pathsFor, pinsOf, readLiveSessions, readPins, readSnapshot, readTime, registryDirFor } from '@epic-pulse/core';
import { parseCommandArgs } from './args.js';
import { failWith, NOT_A_REPO, printLine, usageError } from './io.js';

// The versioned JsonV1 contract for scripts: every live session of the
// repository plus its pins, unscoped, as the extension shows it. Read from disk
// only; nothing is fetched.
export async function runJson(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { strings: ['cwd'] });
  if (!parsed) return usageError('json [--cwd <dir>]');
  const cwd = parsed.strings.get('cwd') ?? process.cwd();
  const dir = await registryDirFor(cwd, env);
  if (dir === undefined) return failWith(NOT_A_REPO);
  const paths = pathsFor(dir);
  const now = Date.now();
  const [sessions, snapshot, pins, progress, time] = await Promise.all([
    readLiveSessions(paths, now), readSnapshot(paths.snapshotFile), readPins(paths), loadProgressFor(cwd), readTime(paths),
  ]);
  printLine(JSON.stringify(buildView({ snapshot, sessions, pins: pinsOf(pins), now, progress, time }), null, 2));
  return 0;
}
