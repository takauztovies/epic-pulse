import type { JsonChild, JsonEpic, JsonV1 } from '@epic-pulse/core';

// Copies of one child in two copies of its epic share a URL; one without a URL
// falls back to its number, and a plain checklist line to its text.
function childKey(child: JsonChild): string {
  if (child.url !== null) return child.url;
  return child.key === null ? `text:${child.title}` : child.key;
}

function newest(copies: readonly JsonEpic[]): JsonEpic {
  return copies.reduce((best, epic) => (Date.parse(epic.fetchedAt) > Date.parse(best.fetchedAt) ? epic : best));
}

// Per copy, the first child with a key decides: a checklist that lists one
// issue twice must not count its sessions twice.
function countsByChild(epic: JsonEpic): ReadonlyMap<string, number> {
  return new Map([...epic.children].reverse().map((child) => [childKey(child), child.sessionCount] as const));
}

// The newest copy is shown, and every copy's sessions are counted on it.
function mergeCopies(copies: readonly JsonEpic[]): JsonEpic {
  const shown = newest(copies);
  const others = copies.filter((copy) => copy !== shown).map(countsByChild);
  const children = shown.children.map((child) => ({
    ...child,
    sessionCount: others.reduce((sum, counts) => sum + (counts.get(childKey(child)) ?? 0), child.sessionCount),
  }));
  return { ...shown, children };
}

// One epic can reach a multi-root window through two registries: two clones
// of one repository, or issues of two repositories under one parent. Each
// registry counts only its own sessions, so the counts add up. Epics keep the
// order they first appear in: folder order, then each view's own order.
export function mergeEpics(views: readonly JsonV1[]): readonly JsonEpic[] {
  const all = views.flatMap((view) => view.epics);
  const urls = [...new Set(all.map((epic) => epic.url))];
  return urls.map((url) => mergeCopies(all.filter((epic) => epic.url === url)));
}
