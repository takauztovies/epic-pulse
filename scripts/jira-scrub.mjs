// What a Jira recording must not keep: whoever the demo account is, and where.
// Account ids, addresses, avatar and self links go; a mention in a description
// keeps its text and loses the id behind it. The product reads none of these.
const PERSONAL_KEYS = new Set(['emailAddress', 'accountId', 'avatarUrls', 'self', 'timeZone', 'accountType', 'active']);

export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !PERSONAL_KEYS.has(key)).map(([key, inner]) => [key, scrub(inner)]));
  if (kept.type === 'mention' && kept.attrs && typeof kept.attrs === 'object') return { ...kept, attrs: { text: kept.attrs.text } };
  return kept;
}
