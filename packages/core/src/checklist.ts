import { issueUrl, makeRef } from './ref.js';
import type { IssueRef, Status } from './schemas/common.js';
import type { Child } from './schemas/snapshot.js';

export interface ChecklistItem {
  readonly text: string;
  readonly checked: boolean;
  readonly struck: boolean;
}

const TITLE_MAX = 300;
// GitHub task lists: any bullet or "1." marker, `[ ]`/`[x]`/`[X]`, then text.
// The box needs exactly one character and the text needs a non-space character.
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\][ \t]+(.*\S)\s*$/;
const FENCE = /^\s*(```|~~~)/;
// A wholly struck item, not `~~a~~ and ~~b~~`, which is two struck words.
const STRUCK = /^~~(?:(?!~~).)+~~$/;

// Removes `<!-- ... -->` (single or multi line). A template comment left in an
// issue body must not count as checklist items.
function withoutComments(lines: readonly string[]): readonly string[] {
  let inComment = false;
  return lines.map((raw) => {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) return '';
      inComment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--.*?-->/g, '');
    const start = line.indexOf('<!--');
    if (start === -1) return line;
    inComment = true;
    return line.slice(0, start);
  });
}

// Drops fenced code blocks: documentation epics quote checklists as examples.
function withoutFences(lines: readonly string[]): readonly string[] {
  let fence: string | undefined;
  return lines.filter((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (fence === undefined || fence === marker)) {
      fence = fence === undefined ? marker : undefined;
      return false;
    }
    return fence === undefined;
  });
}

export function parseChecklist(body: string): readonly ChecklistItem[] {
  const lines = withoutFences(withoutComments(body.split(/\r?\n/)));
  return lines.flatMap((line) => {
    const match = ITEM.exec(line);
    if (!match) return [];
    const text = match[2]!.trim();
    return [{ text, checked: match[1] !== ' ', struck: STRUCK.test(text) }];
  });
}

function statusOf(item: ChecklistItem): Status {
  if (item.struck) return 'dropped';
  return item.checked ? 'done' : 'todo';
}

const REF_AT_START = [
  /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i,
  /^()([\w.-]+)\/([\w.-]+)#(\d+)/,
  /^()()()#(\d+)/,
] as const;

// Only an item that STARTS with a reference is that issue. "Blocked by #33" is
// prose about another issue and must not be linked as the item itself.
function startRef(text: string, epic: IssueRef): IssueRef | undefined {
  for (const pattern of REF_AT_START) {
    const m = pattern.exec(text);
    if (m) {
      return makeRef({
        host: m[1] || epic.host,
        owner: m[2] || epic.owner,
        repo: m[3] || epic.repo,
        number: Number(m[4]),
      });
    }
  }
  return undefined;
}

export function checklistChildren(body: string, epic: IssueRef): readonly Child[] {
  return parseChecklist(body).map((item) => {
    const bare = item.struck ? item.text.slice(2, -2) : item.text;
    const ref = startRef(bare.trim(), epic);
    return {
      number: ref?.number ?? null,
      title: bare.trim().slice(0, TITLE_MAX),
      url: ref ? issueUrl(ref) : null,
      status: statusOf(item),
    };
  });
}
