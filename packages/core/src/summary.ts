// A few readable lines of an epic's description for the hover, never the
// whole text: comments, code blocks, images, link targets, heading marks and
// emphasis marks are dropped, whitespace is collapsed, and what is left is
// cut at a word.
export const SUMMARY_MAX = 280;

export function summaryOf(body: string): string | undefined {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|`/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|>\s*)/, '').trim())
    .filter((line) => line.length > 0);
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), SUMMARY_MAX / 2))}…`;
}
