import * as vscode from 'vscode';
import { detailsText, type DetailsInput } from '../details.js';
import { COMMAND } from '../ids.js';
import { issueLink } from '../links.js';
import type { Poller } from '../poller.js';
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
  if (await signIn(deps.log)) await deps.poller.trigger();
}

export function registerCommands(deps: CommandDeps): readonly vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND.refresh, () => deps.poller.trigger()),
    vscode.commands.registerCommand(COMMAND.openIssue, (value: unknown) => openIssue(value, deps.log)),
    vscode.commands.registerCommand(COMMAND.signIn, () => signInAndRefresh(deps)),
    vscode.commands.registerCommand(COMMAND.showStatus, () => showStatus(deps)),
  ];
}
