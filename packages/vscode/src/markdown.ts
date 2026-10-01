// Issue titles are text that anyone who can edit an issue chose. In a
// Markdown tooltip they must stay text: every ASCII punctuation character
// Markdown gives a meaning is escaped, which also stops GitHub-style autolinks
// (`https:`, `www.`, `name@host`), and line breaks become spaces.
const MARKDOWN_PUNCTUATION = /[\\`*_{}[\]()<>#+\-.!|~:@&$=]/g;

export function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(MARKDOWN_PUNCTUATION, (char) => `\\${char}`);
}
