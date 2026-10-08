import { parseHostList } from '@epic-pulse/core';
import * as vscode from 'vscode';
import { errorLabel, outcomeLine, type DetailsInput } from '../details.js';
import { CONFIG_SECTION, OVERVIEW_ID, VIEW_ID } from '../ids.js';
import { buildModel } from '../model.js';
import { pollAll, readAll, type RepoResult } from '../poll.js';
import { Poller, type PollMode } from '../poller.js';
import { discoverRepos } from '../repos.js';
import { parseSettings, type Settings } from '../settings.js';
import { statusBarOf } from '../status-model.js';
import { treeOf } from '../tree-model.js';
import { PROVIDERS, readAuth } from './auth.js';
import { registerCommands } from './commands.js';
import { StatusBar } from './status-bar.js';
import { Overview } from './overview.js';
import { EpicTree } from './tree.js';

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return parseSettings({ refreshSeconds: config.get<unknown>('refreshSeconds'), statusBarEnabled: config.get<unknown>('statusBar.enabled') });
}

// Local folders only: a virtual workspace has no .git directory to read.
function folderPaths(): readonly string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
}

// Wires the poller to the tree, the status bar, the commands and the editor's
// events. Between polls it keeps the last results for the details view and
// the last log line per repository; the poll's token is not among them.
export class Controller {
  readonly #log = vscode.window.createOutputChannel('Epic Pulse', { log: true });
  readonly #tree = new EpicTree();
  readonly #overview = new Overview();
  #settings = readSettings();
  readonly #statusBar = new StatusBar(this.#settings.statusBarEnabled);
  readonly #poller: Poller;
  #latest: DetailsInput | undefined;
  #logged: ReadonlyMap<string, string> = new Map();

  // The first poll runs at once, focused or not, so a window that starts in
  // the background still shows something; after that, ticks without focus only
  // read the files again, and the refresh waits for focus.
  constructor(context: vscode.ExtensionContext) {
    this.#poller = new Poller({
      run: (mode) => this.#poll(mode),
      intervalMs: this.#settings.refreshSeconds * 1000,
      focused: vscode.window.state.focused,
      onError: (error) => this.#log.error(`poll failed: ${errorLabel(error)}`),
    });
    const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.#tree, showCollapseAll: true });
    const overview = vscode.window.registerWebviewViewProvider(OVERVIEW_ID, this.#overview);
    const commands = registerCommands({ poller: this.#poller, log: this.#log, latest: () => this.#latest });
    context.subscriptions.push(this.#log, this.#tree, view, overview, this.#statusBar, ...commands, ...this.#listeners());
    context.subscriptions.push({ dispose: () => void this.dispose() });
    void this.#poller.trigger();
  }

  dispose(): Promise<void> {
    return this.#poller.dispose();
  }

  async #poll(mode: PollMode): Promise<void> {
    const now = Date.now();
    const next = mode === 'read' ? await this.#reread(now) : await this.#refreshed(now);
    if (next === undefined) return;
    this.#latest = next;
    const model = buildModel(next);
    this.#tree.update(treeOf(model));
    this.#overview.update(model.epics);
    this.#statusBar.show(statusBarOf(model));
    this.#logChanges(next.results);
  }

  async #refreshed(now: number): Promise<DetailsInput> {
    const auth = await readAuth(this.#log);
    const repos = await discoverRepos(folderPaths(), process.env);
    const results = await pollAll(repos, { now, env: process.env, grant: auth.grant });
    return { results, accounts: auth.accounts, hostProblems: parseHostList(process.env['EPIC_PULSE_HOSTS']).problems, now };
  }

  // Nothing to read again before a poll has finished; the tick that finds that
  // out leaves the screen as it is.
  async #reread(now: number): Promise<DetailsInput | undefined> {
    const latest = this.#latest;
    return latest && { ...latest, results: await readAll(latest.results, now), now };
  }

  // A line when a repository's outcome changes, not one per poll.
  #logChanges(results: readonly RepoResult[]): void {
    const lines = new Map(results.map((result) => [result.repo.dir, outcomeLine(result)] as const));
    for (const [dir, line] of lines) if (this.#logged.get(dir) !== line) this.#log.info(line);
    this.#logged = lines;
  }

  #listeners(): readonly vscode.Disposable[] {
    return [
      vscode.window.onDidChangeWindowState((state) => this.#poller.setFocused(state.focused)),
      vscode.authentication.onDidChangeSessions((event) => {
        if (PROVIDERS.has(event.provider.id)) void this.#poller.trigger();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.#poller.trigger()),
      vscode.workspace.onDidChangeConfiguration((event) => this.#onConfiguration(event)),
    ];
  }

  #onConfiguration(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      this.#settings = readSettings();
      this.#poller.setIntervalMs(this.#settings.refreshSeconds * 1000);
      this.#statusBar.setEnabled(this.#settings.statusBarEnabled);
    }
    if (event.affectsConfiguration('github-enterprise.uri')) void this.#poller.trigger();
  }
}
