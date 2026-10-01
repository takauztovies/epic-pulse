import type * as vscode from 'vscode';
import { Controller } from './ui/controller.js';

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new Controller(context);
}

// VS Code waits a little for this promise: a refresh in flight then finishes
// and releases its lock, instead of leaving it to go stale for a minute.
export function deactivate(): Promise<void> | undefined {
  return controller?.dispose();
}
