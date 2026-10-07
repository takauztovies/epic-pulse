import * as vscode from 'vscode';
import type { StatusBarView } from '../status-model.js';

// Hidden until the first poll has said what to show, so a window without a
// repository never flashes an item it then takes away.
export class StatusBar implements vscode.Disposable {
  readonly #item = vscode.window.createStatusBarItem('epicPulse.status', vscode.StatusBarAlignment.Left, 0);
  #view: StatusBarView | undefined;
  #enabled: boolean;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
    this.#item.name = 'Epic Pulse';
  }

  show(view: StatusBarView): void {
    this.#view = view;
    this.#render();
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.#render();
  }

  dispose(): void {
    this.#item.dispose();
  }

  // The tooltip is untrusted Markdown: no command links, HTML or theme icons.
  #render(): void {
    const view = this.#view;
    if (view === undefined || !view.visible || !this.#enabled) {
      this.#item.hide();
      return;
    }
    this.#item.text = view.text;
    this.#item.tooltip = new vscode.MarkdownString(view.tooltip);
    this.#item.command = view.command;
    this.#item.color = view.color === undefined ? undefined : new vscode.ThemeColor(view.color);
    this.#item.show();
  }
}
