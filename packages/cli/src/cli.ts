import { errnoOf } from '@epic-pulse/core';
import { runDoctor } from './doctor.js';
import { runHook } from './hook.js';
import { runInstall } from './install.js';
import { printError, printLine, usageError } from './io.js';
import { runJson } from './json.js';
import { runRefresh } from './refresh-cmd.js';
import { runStatusline } from './statusline.js';
import { runTrack } from './track.js';

type Command = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;

const USAGE = `usage: epic-pulse <command>

  hook                          record one Claude Code hook call (payload on stdin)
  statusline                    print this session's status line (payload on stdin)
  statusline install [--dry-run] [--project]
                                point Claude Code's statusLine at epic-pulse
  json [--cwd <dir>]            print the JSON v1 view of a repository
  track <issue> [--repo]        pin an issue or epic: number, owner/repo#N or URL
  untrack <issue> [--repo]      remove that pin
  refresh                       fetch from GitHub whatever is due, now
  doctor                        check the setup and say what is missing`;

async function statusline(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'install') return runInstall(rest, env);
  return sub === undefined ? runStatusline(env) : usageError('statusline [install [--dry-run] [--project]]');
}

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ['hook', (_args, env) => runHook(env)],
  ['statusline', statusline],
  ['json', runJson],
  ['track', (args, env) => runTrack('track', args, env)],
  ['untrack', (args, env) => runTrack('untrack', args, env)],
  ['refresh', runRefresh],
  ['doctor', runDoctor],
]);

// A command that throws is reported by its errno code alone: a library
// message can carry a path or a header, and neither belongs on a terminal.
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [name, ...args] = argv;
  if (name === '--help' || name === '-h' || name === 'help') {
    printLine(USAGE);
    return 0;
  }
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (command === undefined) {
    printError(USAGE);
    return 2;
  }
  try {
    return await command(args, env);
  } catch (error) {
    printError(`epic-pulse: ${name} failed (${errnoOf(error) ?? 'internal error'})`);
    return 1;
  }
}
