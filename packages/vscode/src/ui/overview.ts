import { randomBytes } from 'node:crypto';
import type { JsonEpic } from '@epic-pulse/core';
import * as vscode from 'vscode';
import { overviewHtml } from '../overview-html.js';
import { epicClickCommand } from '../tree-model.js';

// The Overview panel: coloured bars and every status count per epic. It keeps
// the last epics it was given; the page sends back only an index into them,
// never a URL, so a click can only do what the tree's own click does.
export class Overview implements vscode.WebviewViewProvider {
  #view: vscode.WebviewView | undefined;
  #epics: readonly JsonEpic[] = [];

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: unknown) => this.#click(message));
    view.onDidDispose(() => { this.#view = undefined; });
    this.#render();
  }

  update(epics: readonly JsonEpic[]): void {
    this.#epics = epics;
    this.#render();
  }

  #render(): void {
    if (this.#view) this.#view.webview.html = overviewHtml(this.#epics, randomBytes(16).toString('hex'));
  }

  #click(message: unknown): void {
    const index = typeof message === 'object' && message !== null ? (message as { index?: unknown }).index : undefined;
    const epic = typeof index === 'number' && Number.isInteger(index) ? this.#epics[index] : undefined;
    const command = epic && epicClickCommand(epic);
    if (command) void vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  }
}
