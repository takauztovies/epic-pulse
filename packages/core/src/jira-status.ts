import type { JiraConfig } from './jira-config.js';
import { DEFAULT_DROPPED } from './jira-config.js';
import { StatusSchema, type Status } from './schemas/common.js';

// A Jira workflow is whatever the project made of it, so the lane comes from
// what Jira itself says about a status, its category, with the repository's own
// mapping on top:
//   1. a status named in `statusMap` is that lane;
//   2. category "new" is todo, "indeterminate" is in progress, "done" is done
//      (dropped when the resolution says the work was decided against);
//   3. an in-progress status with "review" in its name is in review.
export interface JiraStatusFacts {
  readonly statusName: string | undefined;
  readonly categoryKey: string | undefined;
  readonly resolution: string | undefined;
}

// A status's name is whatever a Jira admin typed, and the map is a plain object,
// so a read by that name finds what every object inherits: a status called
// `Constructor` is `constructor` once lowercased, and the map answered with
// `Object`, a function that is no lane, which voided the epic it sat in on every
// run (and `__proto__` answered with the prototype itself). Only an entry the map
// holds itself counts, and what it holds must still be one of the five, as the
// board's option tables are read (board-config.ts).
function mappedLane(statusMap: Readonly<Record<string, Status>> | undefined, name: string): Status | undefined {
  if (statusMap === undefined || !Object.hasOwn(statusMap, name)) return undefined;
  const lane = StatusSchema.safeParse(statusMap[name]);
  return lane.success ? lane.data : undefined;
}

export function deriveJiraStatus(facts: JiraStatusFacts, config: Pick<JiraConfig, 'statusMap' | 'droppedResolutions'> | undefined): Status {
  const name = (facts.statusName ?? '').trim().toLowerCase();
  const mapped = mappedLane(config?.statusMap, name);
  if (mapped) return mapped;
  if (facts.categoryKey === 'done') {
    const dropped = config?.droppedResolutions ?? DEFAULT_DROPPED;
    return dropped.includes((facts.resolution ?? '').trim().toLowerCase()) ? 'dropped' : 'done';
  }
  if (facts.categoryKey === 'indeterminate') return /review/.test(name) ? 'in_review' : 'in_progress';
  return 'todo';
}
