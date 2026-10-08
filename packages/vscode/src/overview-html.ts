import { STATUSES, type JsonEpic, type Status } from '@epic-pulse/core';
import { epicSessionsText, progressText, STATUS_TEXT } from './labels.js';

// The Overview panel as one HTML document: a card per epic with a coloured
// progress bar and every status with its count, zeros included. Every string
// that came from GitHub goes through escapeHtml; the bar is a <progress>
// element, so no inline style is needed and the CSP can refuse them all.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
body{padding:0 10px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
.card{margin:10px 0 14px}
.head{all:unset;display:flex;justify-content:space-between;gap:8px;width:100%;cursor:pointer;font-weight:600}
.head:hover .title{text-decoration:underline}
.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pct{flex:none}
progress{appearance:none;display:block;width:100%;height:8px;margin:6px 0;border:0;border-radius:4px;overflow:hidden}
progress::-webkit-progress-bar{background:var(--vscode-input-background);border-radius:4px}
progress::-webkit-progress-value{background:var(--vscode-charts-blue);border-radius:4px}
progress.full::-webkit-progress-value{background:var(--vscode-charts-green)}
.legend{display:flex;flex-wrap:wrap;gap:2px 12px;margin:0;padding:0;list-style:none}
.dot{display:inline-block;width:8px;height:8px;margin-right:4px;border-radius:50%}
.todo{background:var(--vscode-descriptionForeground)}.in_progress{background:var(--vscode-charts-yellow)}
.in_review{background:var(--vscode-charts-purple)}.done{background:var(--vscode-charts-green)}
.dropped{background:var(--vscode-disabledForeground)}
.meta{margin-top:4px;color:var(--vscode-descriptionForeground);font-size:.9em}
`;

const SCRIPT = `const api=acquireVsCodeApi();document.addEventListener('click',(e)=>{const el=e.target.closest('[data-i]');if(el)api.postMessage({index:Number(el.dataset.i)})});`;

function legendItem(epic: JsonEpic, status: Status): string {
  return `<li><span class="dot ${status}"></span>${STATUS_TEXT[status].label} <b>${epic.counts[status]}</b></li>`;
}

function card(epic: JsonEpic, index: number): string {
  const stale = epic.stale ? ' · stale' : '';
  return `<section class="card">
<button class="head" data-i="${index}"><span class="title">#${epic.number} ${escapeHtml(epic.title)}</span><span class="pct">${epic.percent}%</span></button>
<progress class="${epic.percent === 100 ? 'full' : ''}" max="100" value="${epic.percent}"></progress>
<ul class="legend">${STATUSES.map((status) => legendItem(epic, status)).join('')}</ul>
<div class="meta">${progressText(epic)} · ${epicSessionsText(epic)}${stale}</div>
</section>`;
}

export function overviewHtml(epics: readonly JsonEpic[], nonce: string): string {
  const body = epics.length === 0 ? '<p class="meta">No epic to show. The Epics view says why.</p>' : epics.map(card).join('\n');
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style nonce="${nonce}">${STYLE}</style></head><body>${body}<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
