// The plain text of an Atlassian Document Format description: every `text`
// node, with a space where a block ends, so the epic's summary can be cut from
// it. Anything that is not text (media, mentions' ids, macros) is left out.
// The description is whatever a user typed, so the walk is bounded three ways:
// depth, characters kept, and nodes visited. The characters are counted as they
// are added: re-measuring the output at every node made a description of 100,000
// tiny nodes take 14 seconds.
const MAX_DEPTH = 20;
const MAX_CHARS = 4000;
const MAX_NODES = 5000;
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule', 'panel', 'tableRow', 'hardBreak']);

interface Walk {
  readonly out: string[];
  length: number;
  nodes: number;
}

function isNode(value: unknown): value is { type?: unknown; text?: unknown; content?: unknown } {
  return typeof value === 'object' && value !== null;
}

function full(walk: Walk): boolean {
  return walk.length > MAX_CHARS || walk.nodes >= MAX_NODES;
}

function add(walk: Walk, text: string): void {
  walk.out.push(text);
  walk.length += text.length;
}

function collect(node: unknown, depth: number, walk: Walk): void {
  if (!isNode(node) || depth > MAX_DEPTH || full(walk)) return;
  walk.nodes += 1;
  if (node.type === 'codeBlock') return;
  if (typeof node.text === 'string') add(walk, node.text);
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (full(walk)) break;
      collect(child, depth + 1, walk);
    }
  }
  if (typeof node.type === 'string' && BLOCKS.has(node.type)) add(walk, '\n');
}

export function adfText(description: unknown): string {
  if (typeof description === 'string') return description.slice(0, MAX_CHARS);
  const walk: Walk = { out: [], length: 0, nodes: 0 };
  collect(description, 0, walk);
  return walk.out.join('').slice(0, MAX_CHARS);
}
