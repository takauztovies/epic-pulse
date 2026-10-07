import * as vscode from 'vscode';
import { detailsText, type DetailsInput } from '../details.js';
import { COMMAND } from '../ids.js';
import { issueLink } from '../links.js';
import { signedOutHosts } from '../model.js';
import type { Poller } from '../poller.js';
import type { RepoTarget } from '../repos.js';
import { trackIn, untrackEverywhere } from '../track.js';
import type { TreeNode } from '../tree-model.js';
import { signIn } from './auth.js';

export interface CommandDeps {
  readonly poller: Poller;
  readonly log: vscode.LogOutputChannel;
  // The last finished poll, for the details view.
  readonly latest: () => DetailsInput | undefined;
}

async function openIssue(value: unknown, log: vscode.LogOutputChannel): Promise<void> {
  const link = issueLink(value);
  if (link === undefined) {
    log.warn('openIssue refused a link that is not an http(s) URL');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(link, true));
}

function showStatus(deps: CommandDeps): void {
  const latest = deps.latest();
  deps.log.info(latest ? detailsText(latest) : 'Epic Pulse has not finished its first refresh yet.');
  deps.log.show(true);
}

async function signInAndRefresh(deps: CommandDeps): Promise<void> {
  if (await signIn(deps.log, signedOutHosts(deps.latest()?.results ?? []))) await deps.poller.trigger();
}

function reposOf(deps: CommandDeps): readonly RepoTarget[] {
  return (deps.latest()?.results ?? []).map((result) => result.repo);
}

async function pickRepo(repos: readonly RepoTarget[]): Promise<RepoTarget | undefined> {
  if (repos.length <= 1) return repos[0];
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.label, repo })),
    { placeHolder: 'Which repository?' },
  );
  return picked?.repo;
}

// Prompts for an issue or epic and pins it to the repository's pins.json, so
// it shows in the tree whether or not a live session is working on it.
async function track(deps: CommandDeps): Promise<void> {
  const repo = await pickRepo(reposOf(deps));
  if (!repo) {
    void vscode.window.showErrorMessage('epic-pulse: no git repository in this workspace to track an issue in.');
    return;
  }
  const text = await vscode.window.showInputBox({ prompt: 'Issue or epic: a number, owner/repo#N, or an issue URL', placeHolder: '123' });
  if (text === undefined) return;
  const result = await trackIn(repo, text, Date.now());
  void (result.ok ? vscode.window.showInformationMessage(result.message) : vscode.window.showErrorMessage(result.message));
  if (result.ok) await deps.poller.trigger();
}

// Removes the pin from every repository the workspace knows about: the tree
// node names only the epic's URL, not which repository's pins.json holds it.
async function untrack(node: TreeNode, deps: CommandDeps): Promise<void> {
  if (node.kind !== 'epic') return;
  const result = await untrackEverywhere(reposOf(deps), node.url);
  void (result.ok ? vscode.window.showInformationMessage(result.message) : vscode.window.showErrorMessage(result.message));
  if (result.ok) await deps.poller.trigger();
}

export function registerCommands(deps: CommandDeps): readonly vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND.refresh, () => deps.poller.trigger()),
    vscode.commands.registerCommand(COMMAND.openIssue, (value: unknown) => openIssue(value, deps.log)),
    vscode.commands.registerCommand(COMMAND.signIn, () => signInAndRefresh(deps)),
    vscode.commands.registerCommand(COMMAND.showStatus, () => showStatus(deps)),
    vscode.commands.registerCommand(COMMAND.track, () => track(deps)),
    vscode.commands.registerCommand(COMMAND.untrack, (node: TreeNode) => untrack(node, deps)),
  ];
}
