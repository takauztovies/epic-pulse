import { JIRA_KEY, makeJiraRef, makeRef, parseIssueTarget, kindOf, refKey } from './ref.js';
import type { IssueRef } from './schemas/common.js';
import type { Child, EpicEntry, Snapshot } from './schemas/snapshot.js';

// The whole tree under an epic, however deep. Every sub-epic is an epic entry
// of its own in the snapshot, so it is fetched, cached and paced like any
// other; the tree is only joined back together by reference when it is read.
// These two caps are the safety net for a cyclic or absurdly large hierarchy,
// not a design limit: GitHub itself allows eight levels of sub-issues.
export const MAX_TREE_DEPTH = 8;
export const MAX_TREE_NODES = 2000;

// A child's own reference: its URL names its repository (a sub-issue may live
// elsewhere), a checklist line without one can only be an issue of the epic's
// repository, a Jira child carries its key.
export function childRefOf(child: Child, epic: IssueRef): IssueRef | undefined {
  if (kindOf(epic) === 'jira') {
    const parts = child.key === undefined ? null : JIRA_KEY.exec(child.key);
    return parts ? makeJiraRef({ host: epic.host, project: parts[1] ?? '', number: Number(parts[2]) }) : undefined;
  }
  const target = child.url === null ? undefined : parseIssueTarget(child.url);
  const own = target?.repo;
  if (target && own) return makeRef({ host: own.host ?? epic.host, owner: own.owner, repo: own.repo, number: target.number });
  return child.number === null ? undefined : makeRef({ ...epic, number: child.number });
}

// The children of an epic that have children of their own.
export function subEpicRefs(entry: EpicEntry): readonly IssueRef[] {
  return entry.children.flatMap((child) => {
    const ref = (child.subCount ?? 0) > 0 ? childRefOf(child, entry.ref) : undefined;
    return ref ? [ref] : [];
  });
}

function unique(refs: readonly IssueRef[]): readonly IssueRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref] as const)).values()];
}

// Every sub-epic below the roots that the snapshot already knows of, each once,
// level by level. Sub-epics are known from their parent's entry, so this also
// names ones that have not been fetched yet.
export function descendantEpics(snapshot: Snapshot, roots: readonly IssueRef[]): readonly IssueRef[] {
  const seen = new Set(roots.map(refKey));
  const found: IssueRef[] = [];
  let level = roots;
  for (let depth = 0; depth < MAX_TREE_DEPTH && level.length > 0 && found.length < MAX_TREE_NODES; depth += 1) {
    const next = unique(level.flatMap((ref) => {
      const entry = snapshot.epics[refKey(ref)];
      return entry ? subEpicRefs(entry) : [];
    })).filter((ref) => !seen.has(refKey(ref)));
    next.forEach((ref) => seen.add(refKey(ref)));
    found.push(...next);
    level = next;
  }
  return found;
}

// The keys of every epic that is some other epic's child. They are refreshed
// less often than the epic at the top: see SUB_EPIC_TTL_MS.
export function subEpicKeys(snapshot: Snapshot): ReadonlySet<string> {
  return new Set(Object.values(snapshot.epics).flatMap((entry) => subEpicRefs(entry).map(refKey)));
}
