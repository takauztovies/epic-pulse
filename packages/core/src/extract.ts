import { isAbsolute, resolve } from 'node:path';
import { commandSignals, type CommandSignal } from './extract-commands.js';
import { absolutePaths, branchRef, worktreeContexts, type WorktreeContext } from './extract-paths.js';
import type { JiraConfig } from './jira-config.js';
import { jiraKeysIn } from './jira-keys.js';
import { DEFAULT_HOST, makeJiraRef, makeRef, refKey, type IssueTarget } from './ref.js';
import type { BindVia, IssueRef, RepoRef } from './schemas/common.js';
import type { HookPayload } from './schemas/hook.js';
import type { BindEntry } from './schemas/registry.js';
import { parseShell, type SimpleCommand } from './shell.js';
import { CLOSING } from './status.js';

// What one hook call contributes to the registry: its event and the issues it
// bound or unbound. Refs only, never the command, the path or the content.
export interface Extraction {
  readonly ev: 'start' | 'tool' | 'end';
  readonly binds: readonly BindEntry[];
  readonly unbinds: readonly IssueRef[];
}

type Action = { readonly op: 'bind'; readonly ref: IssueRef; readonly via: BindVia } | { readonly op: 'unbind'; readonly ref: IssueRef };
type PlanItem = { readonly signal: CommandSignal } | { readonly path: string };
type Contexts = ReadonlyMap<string, WorktreeContext>;

const PATH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// More distinct issues than this in one call is triage or a release note, not
// work on an issue, so the call binds nothing.
const MAX_REFS = 3;
const MAX_PATHS = 16;
const VIA_RANK: Readonly<Record<BindVia, number>> = { branch: 0, closing: 1, gh: 2, pin: 3 };

export function hookEvent(name: string | undefined): Extraction['ev'] {
  if (name === 'SessionStart') return 'start';
  return name === 'SessionEnd' ? 'end' : 'tool';
}

export function closingRefs(text: string, base: RepoRef): readonly IssueRef[] {
  return [...text.matchAll(CLOSING)].flatMap((match) => {
    const [owner, repo] = (match[1] ?? match[2] ?? `${base.owner}/${base.repo}`).split('/');
    const ref = owner && repo ? makeRef({ host: base.host, owner, repo, number: Number(match[3]) }) : undefined;
    return ref ? [ref] : [];
  });
}

// A Jira key binds only with a site to put it on: the one its URL names, or the
// one the repository's .epic-pulse.json declares.
function jiraTargetRef(target: NonNullable<IssueTarget['jira']>, number: number, jira: JiraConfig | undefined): IssueRef | undefined {
  const host = target.host ?? jira?.site;
  return host ? makeJiraRef({ host, project: target.project, number }) : undefined;
}

function targetRef(target: IssueTarget, base: RepoRef | undefined, jira: JiraConfig | undefined): IssueRef | undefined {
  if (target.jira) return jiraTargetRef(target.jira, target.number, jira);
  const own = target.repo;
  const repo = own ? { host: own.host ?? base?.host ?? DEFAULT_HOST, owner: own.owner, repo: own.repo } : base;
  return repo ? makeRef({ ...repo, number: target.number }) : undefined;
}

function signalActions(signal: CommandSignal, contexts: Contexts): readonly Action[] {
  const base = 'repo' in signal.hint ? signal.hint.repo : contexts.get(signal.hint.dir)?.remote;
  const jira = 'dir' in signal.hint ? contexts.get(signal.hint.dir)?.config.jira : undefined;
  if (signal.kind === 'closing') {
    const keys = jira ? jiraKeysIn(signal.text, jira) : [];
    return [...(base ? closingRefs(signal.text, base) : []), ...keys].map((ref) => ({ op: 'bind', ref, via: 'closing' }));
  }
  const ref = targetRef(signal.target, base, jira);
  if (!ref) return [];
  return [signal.kind === 'unbind' ? { op: 'unbind', ref } : { op: 'bind', ref, via: signal.via }];
}

function itemActions(item: PlanItem, contexts: Contexts): readonly Action[] {
  if ('signal' in item) return signalActions(item.signal, contexts);
  const context = contexts.get(item.path);
  const ref = context ? branchRef(item.path, context) : undefined;
  return ref ? [{ op: 'bind', ref, via: 'branch' }] : [];
}

// Pure pass over the commands, in order, following `cd` so that a later
// `git commit` is attributed to the directory it runs in. A glob only costs its
// own command its paths: the command's signals, and every other command, still
// count. Where a globbed `cd` lands is unknowable, so the pass stops there
// rather than guess a repository.
function plan(commands: readonly SimpleCommand[], cwd: string): readonly PlanItem[] {
  const items: PlanItem[] = [];
  let dir = cwd;
  let paths = 0;
  for (const command of commands) {
    const cd = command.words[0] === 'cd' ? command.words[1] : undefined;
    if (cd !== undefined && command.glob) break;
    items.push(...commandSignals(command.words, dir).map((signal) => ({ signal })));
    const found = command.glob ? [] : absolutePaths([...command.words, ...command.targets]).slice(0, Math.max(0, MAX_PATHS - paths));
    items.push(...found.map((path) => ({ path })));
    paths += found.length;
    if (cd !== undefined) dir = resolve(dir, cd);
  }
  return items;
}

async function run(items: readonly PlanItem[]): Promise<readonly Action[]> {
  const lookups = items.map((item) => ('path' in item ? item.path : 'dir' in item.signal.hint ? item.signal.hint.dir : ''));
  const contexts = await worktreeContexts(lookups.filter(Boolean));
  return items.flatMap((item) => itemActions(item, contexts));
}

async function toolActions(payload: HookPayload): Promise<readonly Action[]> {
  const input = payload.tool_input;
  const tool = payload.tool_name ?? '';
  if (tool === 'Bash' && input?.command !== undefined && payload.cwd !== undefined) {
    return run(plan(parseShell(input.command).commands, payload.cwd));
  }
  const path = PATH_TOOLS.has(tool) ? (input?.file_path ?? input?.notebook_path) : undefined;
  if (path === undefined || (!isAbsolute(path) && payload.cwd === undefined)) return [];
  return run([{ path: resolve(payload.cwd ?? '', path) }]);
}

// Whether an earlier action on an issue stands against a later one: an unbind
// against any bind but a pin (the rule foldSession applies across calls), and
// the stronger `via` between two binds, so a pin is never downgraded.
function outranks(previous: Action, next: Action): boolean {
  if (next.op === 'unbind') return false;
  return previous.op === 'unbind' ? next.via !== 'pin' : VIA_RANK[previous.via] > VIA_RANK[next.via];
}

// Otherwise later actions win.
function settle(actions: readonly Action[]): Pick<Extraction, 'binds' | 'unbinds'> {
  const final = new Map<string, Action>();
  for (const action of actions) {
    const previous = final.get(refKey(action.ref));
    final.set(refKey(action.ref), previous && outranks(previous, action) ? previous : action);
  }
  if (final.size > MAX_REFS) return { binds: [], unbinds: [] };
  const settled = [...final.values()];
  return {
    binds: settled.flatMap((a) => (a.op === 'bind' ? [{ ref: a.ref, via: a.via }] : [])),
    unbinds: settled.flatMap((a) => (a.op === 'unbind' ? [a.ref] : [])),
  };
}

// Offline by construction: file reads through git.ts and config.ts only.
export async function extract(payload: HookPayload): Promise<Extraction> {
  const ev = hookEvent(payload.hook_event_name);
  return { ev, ...settle(ev === 'tool' ? await toolActions(payload) : []) };
}
