import { STATUSES, type JsonChild, type JsonEpic, type Status } from '@epic-pulse/core';
import { COMMAND } from './ids.js';
import { ageText, countsText, progressText, sessionsText, STATE_TEXT, STATUS_TEXT } from './labels.js';
import type { DisplayState, Model } from './model.js';

// The Epics tree as plain data: Epic → status group → issue, with one notice
// on top for any state other than "ok". The view layer only turns these into
// TreeItems. Labels and tooltips are plain text, never Markdown.

export interface CommandRef {
  readonly command: string;
  readonly title: string;
  readonly arguments?: readonly string[];
}

interface NodeBase {
  // Stable across refreshes, so VS Code keeps what the user expanded.
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly command?: CommandRef;
}

export interface NoticeNode extends NodeBase {
  readonly kind: 'notice';
  readonly state: DisplayState;
}

export interface IssueNode extends NodeBase {
  readonly kind: 'issue';
  readonly url: string | null;
}

export interface GroupNode extends NodeBase {
  readonly kind: 'group';
  readonly status: Status;
  readonly expanded: boolean;
  readonly children: readonly IssueNode[];
}

export interface EpicNode extends NodeBase {
  readonly kind: 'epic';
  readonly url: string;
  readonly children: readonly GroupNode[];
}

export type TreeNode = NoticeNode | EpicNode | GroupNode | IssueNode;

function openCommand(url: string): CommandRef {
  return { command: COMMAND.openIssue, title: 'Open on GitHub', arguments: [url] };
}

function issueNode(child: JsonChild, id: string): IssueNode {
  const label = child.number === null ? child.title : `#${child.number} ${child.title}`;
  const sessions = child.sessionCount > 0 ? [sessionsText(child.sessionCount)] : [];
  return {
    kind: 'issue',
    id,
    label,
    url: child.url,
    description: sessions.join(''),
    tooltip: [label, STATUS_TEXT[child.status].label, ...sessions].join('\n'),
    icon: child.status === 'done' || child.status === 'dropped' ? 'issue-closed' : 'issues',
    ...(child.url === null ? {} : { command: openCommand(child.url) }),
  };
}

// Workflow order, empty groups left out. Work that is moving starts expanded.
// An issue's id is its position, since a checklist may list one issue twice.
function groupNodes(epic: JsonEpic): readonly GroupNode[] {
  return STATUSES.flatMap((status) => {
    const children = epic.children.flatMap((child, index) => (child.status === status ? [issueNode(child, `${epic.url}#${index}`)] : []));
    const { label, icon } = STATUS_TEXT[status];
    if (children.length === 0) return [];
    const expanded = status === 'in_progress' || status === 'in_review';
    return [{ kind: 'group', id: `${epic.url}:${status}`, status, label, description: String(children.length), tooltip: label, icon, expanded, children }];
  });
}

function epicNode(epic: JsonEpic, now: number): EpicNode {
  const progress = progressText(epic);
  const stale = epic.stale ? [epic.error === null ? 'stale' : `stale (${epic.error})`] : [];
  return {
    kind: 'epic',
    id: epic.url,
    url: epic.url,
    label: epic.title,
    description: [progress, ...stale].join(' · '),
    tooltip: [`#${epic.number} ${epic.title}`, `${progress}: ${countsText(epic)}`, ageText(epic.fetchedAt, now)].join('\n'),
    icon: 'milestone',
    command: openCommand(epic.url),
    children: groupNodes(epic),
  };
}

function noticeDescription(model: Model): string {
  if (model.repoCount === 0) return 'No git repository in this workspace';
  if (model.error !== null) return model.error;
  return model.state === 'stale' ? ageText(model.fetchedAt, model.now) : '';
}

// Signed out offers the sign-in; every other notice opens the details.
function noticeNode(model: Model): NoticeNode | undefined {
  if (model.state === 'ok') return undefined;
  const text = STATE_TEXT[model.state];
  const signIn = model.state === 'signed-out';
  return {
    kind: 'notice',
    id: `notice:${model.state}`,
    state: model.state,
    label: text.label,
    description: noticeDescription(model),
    tooltip: [text.detail, ...(model.error === null ? [] : [`Code: ${model.error}`])].join('\n'),
    icon: text.icon,
    command: signIn ? { command: COMMAND.signIn, title: text.label } : { command: COMMAND.showStatus, title: 'Show status details' },
  };
}

export function treeOf(model: Model): readonly TreeNode[] {
  const notice = noticeNode(model);
  return [...(notice ? [notice] : []), ...model.epics.map((epic) => epicNode(epic, model.now))];
}

// What the tree shows before the first poll has finished.
export function loadingTree(): readonly TreeNode[] {
  const { label, detail, icon } = STATE_TEXT.loading;
  const command = { command: COMMAND.showStatus, title: 'Show status details' };
  return [{ kind: 'notice', id: 'notice:loading', state: 'loading', label, description: '', tooltip: detail, icon, command }];
}

export function childrenOf(node: TreeNode): readonly TreeNode[] {
  return node.kind === 'epic' || node.kind === 'group' ? node.children : [];
}
