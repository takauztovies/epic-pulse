// Installs the status line into a throwaway project with `--project`, then runs
// the command it wrote under each shell named on the command line, the way
// Claude Code runs a status line command: the status payload on stdin and the
// project as the working directory. Fails unless every shell prints a status
// line. The unit tests only have a POSIX sh; CI runs this under cmd and
// PowerShell on Windows, where a teammate's shell is one of those.
//
//   node scripts/check-statusline-shells.mjs sh
//   node scripts/check-statusline-shells.mjs cmd pwsh
//
// Needs the built bundle (`pnpm build`). Exit 0 every shell printed a status
// line, 1 one did not, 2 usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../packages/cli/dist/epic-pulse.mjs', import.meta.url));

// Each shell takes one command string its own way. cmd is given what Node's own
// `shell` option gives it, `/d /s /c "<command>"` handed over verbatim, whose
// outer quotes /s strips.
const SHELLS = {
  sh: { file: 'sh', args: (command) => ['-c', command], verbatim: false },
  cmd: { file: 'cmd.exe', args: (command) => ['/d', '/s', '/c', `"${command}"`], verbatim: true },
  pwsh: { file: 'pwsh', args: (command) => ['-NoProfile', '-NonInteractive', '-Command', command], verbatim: false },
};

// Where the runtime goes: CLAUDE_CONFIG_DIR when it is set, ~/.claude when not.
// The command must find it either way, so each scenario also says where the
// install has to have put it: one that landed elsewhere did not test what it names.
function scenarios(temp) {
  const [config, home] = [join(temp, 'config'), join(temp, 'home')];
  const unset = { ...process.env, HOME: home, USERPROFILE: home };
  delete unset.CLAUDE_CONFIG_DIR;
  return [
    { name: 'CLAUDE_CONFIG_DIR set', env: { ...process.env, CLAUDE_CONFIG_DIR: config }, runtime: join(config, 'epic-pulse', 'runtime.mjs') },
    { name: 'CLAUDE_CONFIG_DIR unset', env: unset, runtime: join(home, '.claude', 'epic-pulse', 'runtime.mjs') },
  ];
}

function install(project, scenario) {
  const run = spawnSync(process.execPath, [BUNDLE, 'statusline', 'install', '--project'], { cwd: project, env: scenario.env, encoding: 'utf8' });
  if (run.status !== 0) return `statusline install --project exited ${run.status}: ${run.stderr.trim()}`;
  return existsSync(scenario.runtime) ? undefined : `the install did not put the runtime at ${scenario.runtime}`;
}

// Why a shell's run counts as a failure, or undefined when it printed a status line.
function failure(run) {
  if (run.error) return `the shell did not start (${run.error.code ?? run.error.message})`;
  if (run.status !== 0) return `exit ${run.status}: ${`${run.stdout}${run.stderr}`.trim()}`;
  return run.stdout.trim() === '' ? `printed no status line: ${run.stderr.trim()}` : undefined;
}

function runUnder(shell, command, context) {
  const payload = JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000000', cwd: context.project, workspace: { current_dir: context.project } });
  const spec = SHELLS[shell];
  return spawnSync(spec.file, spec.args(command), { cwd: context.project, env: context.env, input: payload, encoding: 'utf8', windowsVerbatimArguments: spec.verbatim });
}

function check(shells, temp) {
  const project = join(temp, 'project');
  const results = [];
  for (const scenario of scenarios(temp)) {
    mkdirSync(project, { recursive: true });
    const broken = install(project, scenario);
    const command = broken ?? JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).statusLine.command;
    for (const shell of shells) {
      const run = broken ? undefined : runUnder(shell, command, { project, env: scenario.env });
      const why = broken ?? failure(run);
      results.push({ label: `${shell}, ${scenario.name}`, why, line: why ? undefined : run.stdout.trim() });
    }
  }
  return results;
}

function main(shells) {
  if (shells.length === 0 || shells.some((shell) => !(shell in SHELLS))) {
    console.error(`usage: node scripts/check-statusline-shells.mjs <${Object.keys(SHELLS).join('|')}>...`);
    return 2;
  }
  const temp = mkdtempSync(join(realpathSync.native(tmpdir()), 'ep-shells-'));
  try {
    const results = check(shells, temp);
    for (const { label, why, line } of results) console.log(why ? `::error::${label}: ${why}` : `${label}: ${line}`);
    return results.some((result) => result.why) ? 1 : 0;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

process.exitCode = main(process.argv.slice(2));
