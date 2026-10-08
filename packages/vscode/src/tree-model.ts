import { STATUSES, type JsonChild, type JsonEpic, type Status } from '@epic-pulse/core';
import { COMMAND } from './ids.js';
import { activityLines, ageText, barText, countsText, detailLines, epicSessionsText, issueDetailLines, progressText, sessionsText, STATE_TEXT, STATUS_TEXT } from './labels.js';
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
  // A theme color id (e.g. "charts.green") for the icon, or undefined for the
  // theme's default. Most nodes have none.
  readonly iconColor?: string;
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

// A click goes to the live Claude Code session working on the item when there
// is one, and to GitHub otherwise; "Open on GitHub" stays in the context menu.
function clickCommand(url: string | null, sessionIds: readonly string[]): CommandRef | undefined {
  if (sessionIds.length > 0) return { command: COMMAND.openSession, title: 'Open Claude Code session', arguments: sessionIds };
  return url === null ? undefined : openCommand(url);
}

// What a click on an epic does, for the tree and for the Overview panel.
export function epicClickCommand(epic: JsonEpic): CommandRef | undefined {
  return clickCommand(epic.url, epic.sessionIds);
}

function spreadCommand(command: CommandRef | undefined): { readonly command?: CommandRef } {
  return command === undefined ? {} : { command };
}

function issueNode(child: JsonChild, id: string, now: number): IssueNode {
  const label = child.number === null ? child.title : `#${child.number} ${child.title}`;
  const sessions = child.sessionCount > 0 ? [sessionsText(child.sessionCount)] : [];
  return {
    kind: 'issue',
    id,
    label,
    url: child.url,
    description: sessions.join(''),
    tooltip: [label, STATUS_TEXT[child.status].label, ...issueDetailLines(child), ...sessions, ...activityLines(child, now)].join('\n'),
    icon: child.status === 'done' || child.status === 'dropped' ? 'issue-closed' : 'issues',
    // A live session on it right now, regardless of status: green marks
    // "someone is here", distinct from the Todo/In progress/.../Done group
    // it's already sorted into by workflow state.
    iconColor: child.sessionCount > 0 ? 'charts.green' : undefined,
    ...spreadCommand(clickCommand(child.url, child.sessionIds)),
  };
}

// Workflow order, every status shown even with none, so an epic always reads the same. Work that is moving, and work that is
// finished, starts expanded; only Todo and Dropped start collapsed.
// An issue's id is its position, since a checklist may list one issue twice.
function groupNodes(epic: JsonEpic, now: number): readonly GroupNode[] {
  return STATUSES.flatMap((status) => {
    const children = epic.children.flatMap((child, index) => (child.status === status ? [issueNode(child, `${epic.url}#${index}`, now)] : []));
    const { label, icon } = STATUS_TEXT[status];
    const expanded = status === 'in_progress' || status === 'in_review' || status === 'done';
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
    label: `#${epic.number} ${barText(epic.percent)} ${epic.percent}% ${epic.title}`,
    description: [progress, epicSessionsText(epic), ...stale].join(' · '),
    tooltip: [`#${epic.number} ${epic.title}`, `${progress}: ${countsText(epic)}`, ...detailLines(epic, now), epicSessionsText(epic), ...activityLines(epic, now), ageText(epic.fetchedAt, now)].join('\n'),
    icon: 'milestone',
    iconColor: epic.percent === 100 ? 'charts.green' : undefined,
    ...spreadCommand(clickCommand(epic.url, epic.sessionIds)),
    children: groupNodes(epic, now),
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
