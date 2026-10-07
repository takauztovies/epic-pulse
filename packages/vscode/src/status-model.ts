import type { JsonEpic } from '@epic-pulse/core';
import { COMMAND, FOCUS_VIEW } from './ids.js';
import { ageText, countsText, epicSessionsText, progressText, STATE_TEXT } from './labels.js';
import { escapeMarkdown } from './markdown.js';
import type { Model } from './model.js';

export interface StatusBarView {
  // False with no repository in the workspace. The setting can hide it too.
  readonly visible: boolean;
  // Codicons as `$(name)`. Only numbers, codes and fixed words go in here.
  readonly text: string;
  // Markdown, rendered untrusted. Every outside string in it is escaped.
  readonly tooltip: string;
  readonly command: string;
}

function staleMarks(epic: JsonEpic): readonly string[] {
  if (!epic.stale) return [];
  return [epic.error === null ? 'stale' : `stale (${epic.error})`];
}

// The first epic in full, the others as a count, like the status line.
function epicText(model: Model): string {
  const [first, ...rest] = model.epics;
  if (!first) return '';
  const more = rest.length > 0 ? ` +${rest.length}` : '';
  const stale = model.epics.some((epic) => epic.stale) ? ' $(warning)' : '';
  return `$(pulse) #${first.number} ${progressText(first)}${more}${stale}`;
}

function stateText(model: Model): string {
  if (model.state === 'ok') return '$(pulse) Epic Pulse';
  const { icon, label } = STATE_TEXT[model.state];
  return `$(${icon}) ${label}${model.state === 'error' && model.error !== null ? `: ${model.error}` : ''}`;
}

function header(model: Model): string {
  const live = `${model.liveSessions} live ${model.liveSessions === 1 ? 'session' : 'sessions'}`;
  return `**Epic Pulse** · ${live} · ${ageText(model.fetchedAt, model.now)}`;
}

function stateBlock(model: Model): string {
  if (model.state === 'ok') return '';
  const { label, detail } = STATE_TEXT[model.state];
  const code = model.error === null ? '' : `  \nCode: \`${model.error}\``;
  const action = model.state === 'signed-out' ? '  \nClick here, or run **Epic Pulse: Sign in to GitHub**.' : '';
  return `**${label}**: ${detail}${code}${action}`;
}

function epicBlock(epic: JsonEpic): string {
  const line = [progressText(epic), countsText(epic), ...staleMarks(epic)].join(' · ');
  return `**#${epic.number}** ${escapeMarkdown(epic.title)}  \n${line}  \n${epicSessionsText(epic)}`;
}

// A click signs in when that is what is missing; otherwise it opens the tree.
export function statusBarOf(model: Model): StatusBarView {
  const blocks = [header(model), stateBlock(model), ...model.epics.map(epicBlock)];
  return {
    visible: model.repoCount > 0,
    text: model.epics.length > 0 ? epicText(model) : stateText(model),
    tooltip: blocks.filter((block) => block !== '').join('\n\n'),
    command: model.state === 'signed-out' ? COMMAND.signIn : FOCUS_VIEW,
  };
}
