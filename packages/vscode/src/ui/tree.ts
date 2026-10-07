import * as vscode from 'vscode';
import { childrenOf, loadingTree, type CommandRef, type TreeNode } from '../tree-model.js';

function collapsibleState(node: TreeNode): vscode.TreeItemCollapsibleState {
  if (node.kind === 'epic') return vscode.TreeItemCollapsibleState.Expanded;
  if (node.kind !== 'group') return vscode.TreeItemCollapsibleState.None;
  return node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
}

function command(ref: CommandRef | undefined): vscode.Command | undefined {
  return ref === undefined ? undefined : { command: ref.command, title: ref.title, arguments: [...(ref.arguments ?? [])] };
}

// Plain-text label, description and tooltip: an issue title is never Markdown.
function treeItem(node: TreeNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, collapsibleState(node));
  item.id = node.id;
  item.description = node.description;
  item.tooltip = node.tooltip;
  item.iconPath = new vscode.ThemeIcon(node.icon, node.iconColor === undefined ? undefined : new vscode.ThemeColor(node.iconColor));
  item.command = command(node.command);
  item.contextValue = node.kind;
  return item;
}

// Holds the last tree the model produced and hands it to VS Code on request.
export class EpicTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  #roots: readonly TreeNode[] = loadingTree();

  update(roots: readonly TreeNode[]): void {
    this.#roots = roots;
    this.#changed.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return [...(node === undefined ? this.#roots : childrenOf(node))];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return treeItem(node);
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
