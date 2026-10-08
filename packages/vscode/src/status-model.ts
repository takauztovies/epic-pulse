import type { JsonEpic } from '@epic-pulse/core';
import { COMMAND, FOCUS_VIEW } from './ids.js';
import { activityLines, ageText, countsText, detailLines, epicSessionsText, progressText, STATE_TEXT } from './labels.js';
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
  // A theme color id for the item's foreground, or undefined for the
  // theme's default.
  readonly color?: string;
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
  return `$(pulse) ${first.key} ${progressText(first)}${more}${stale}`;
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

function epicBlock(epic: JsonEpic, now: number): string {
  const line = [progressText(epic), countsText(epic), ...staleMarks(epic)].join(' · ');
  return `**${epic.key}** ${escapeMarkdown(epic.title)}  \n${line}  \n${[...detailLines(epic, now).map(escapeMarkdown), epicSessionsText(epic), ...activityLines(epic, now)].join('  \n')}`;
}

// A click signs in when that is what is missing; otherwise it opens the tree.
// Green once the first epic shown is entirely Done; the theme's own color the
// rest of the time, including while it is stale (a color here is a result,
// not a hint to go look, which $(warning) already is).
function colorOf(model: Model): string | undefined {
  const first = model.epics[0];
  return first && !first.stale && first.percent === 100 ? 'charts.green' : undefined;
}

export function statusBarOf(model: Model): StatusBarView {
  const blocks = [header(model), stateBlock(model), ...model.epics.map((epic) => epicBlock(epic, model.now))];
  return {
    visible: model.repoCount > 0,
    text: model.epics.length > 0 ? epicText(model) : stateText(model),
    tooltip: blocks.filter((block) => block !== '').join('\n\n'),
    command: model.state === 'signed-out' ? COMMAND.signIn : FOCUS_VIEW,
    color: colorOf(model),
  };
}
