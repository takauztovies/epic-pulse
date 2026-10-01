import { DEFAULT_HOST } from '@epic-pulse/core';
import { parseCommandArgs } from './args.js';
import {
  nodeCheck, registryChecks, repoChecks, runtimeCheck, statusLineCheck, tokenCheck, type Check,
} from './doctor-checks.js';
import { printLine, usageError } from './io.js';

function format(checks: readonly Check[]): readonly string[] {
  const width = Math.max(...checks.map(([label]) => label.length));
  return checks.map(([label, value]) => `  ${`${label}:`.padEnd(width + 2)}${value}`);
}

// Reports; changes nothing. It exits 0 whatever it finds, since every line
// already says what, if anything, needs doing.
export async function runDoctor(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (!parseCommandArgs(args, {})) return usageError('doctor');
  const cwd = process.cwd();
  const repo = await repoChecks(cwd);
  const checks: readonly Check[] = [
    nodeCheck(),
    ...repo.checks,
    await tokenCheck(repo.remote?.host ?? DEFAULT_HOST, env),
    ...(await registryChecks(cwd, env, Date.now())),
    await statusLineCheck('user', env, cwd),
    await statusLineCheck('project', env, cwd),
    await runtimeCheck(env),
  ];
  printLine('epic-pulse doctor');
  for (const line of format(checks)) printLine(line);
  return 0;
}
