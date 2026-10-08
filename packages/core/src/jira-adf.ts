// The plain text of an Atlassian Document Format description: every `text`
// node, with a space where a block ends, so the epic's summary can be cut from
// it. Anything that is not text (media, mentions' ids, macros) is left out.
// Depth and output are capped: the description is whatever a user typed.
const MAX_DEPTH = 20;
const MAX_CHARS = 4000;
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule', 'panel', 'tableRow', 'hardBreak']);

function isNode(value: unknown): value is { type?: unknown; text?: unknown; content?: unknown } {
  return typeof value === 'object' && value !== null;
}

function collect(node: unknown, depth: number, out: string[]): void {
  if (!isNode(node) || depth > MAX_DEPTH || out.join('').length > MAX_CHARS) return;
  if (node.type === 'codeBlock') return;
  if (typeof node.text === 'string') out.push(node.text);
  if (Array.isArray(node.content)) for (const child of node.content) collect(child, depth + 1, out);
  if (typeof node.type === 'string' && BLOCKS.has(node.type)) out.push('\n');
}

export function adfText(description: unknown): string {
  if (typeof description === 'string') return description.slice(0, MAX_CHARS);
  const out: string[] = [];
  collect(description, 0, out);
  return out.join('').slice(0, MAX_CHARS);
}
