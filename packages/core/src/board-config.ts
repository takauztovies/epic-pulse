import { z } from 'zod';
import { BOARD_LIMITS, type ProjectConfig } from './schemas/board.js';
import { IssueNumberSchema, OwnerSchema, StatusSchema, type Status } from './schemas/common.js';

// The `project` block of `.epic-pulse.json`: a GitHub Project (v2) board whose
// Status field says where an open issue stands. Opt-in: without a valid owner
// and number there is no board, and status is derived from the issue alone. The
// file is untrusted, so each field is checked on its own and a bad one falls
// back to its default rather than voiding the block (as schemas/config.ts does).
export const DEFAULT_BOARD_FIELD = 'Status';

const RawProjectSchema = z.looseObject({
  owner: z.string().trim().toLowerCase().pipe(OwnerSchema).optional().catch(undefined),
  number: IssueNumberSchema.optional().catch(undefined),
  field: z.string().trim().min(1).max(BOARD_LIMITS.maxFieldLength).optional().catch(undefined),
  statusMap: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

// `In Progress`, `in-progress` and `🚧 In progress` are one option: lowercased,
// with everything that is not a letter or a digit taken out.
export function normaliseOption(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// What an option means when the repository says nothing about it.
export const DEFAULT_BOARD_MAP: Readonly<Record<string, Status>> = {
  todo: 'todo', backlog: 'todo', ready: 'todo',
  inprogress: 'in_progress', doing: 'in_progress', wip: 'in_progress',
  inreview: 'in_review', review: 'in_review', qa: 'in_review', testing: 'in_review',
  done: 'done', complete: 'done', shipped: 'done',
  wontdo: 'dropped', dropped: 'dropped', cancelled: 'dropped', notplanned: 'dropped',
};

// The repository's overrides, keyed by normalised name; an entry whose value is
// not one of the five statuses, or whose name normalises to nothing, is dropped.
function statusMapOf(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, Status>> {
  const entries = Object.entries(value ?? {}).flatMap(([name, lane]) => {
    const key = normaliseOption(name);
    const status = StatusSchema.safeParse(lane);
    return key.length > 0 && key.length <= BOARD_LIMITS.maxNameLength && status.success ? [[key, status.data] as const] : [];
  });
  return Object.fromEntries(entries.slice(0, BOARD_LIMITS.maxStatusMap));
}

// Undefined without an owner and a project number: no board is read.
export function parseProject(value: unknown): ProjectConfig | undefined {
  const raw = RawProjectSchema.safeParse(value);
  if (!raw.success || raw.data.owner === undefined || raw.data.number === undefined) return undefined;
  const { owner, number, field } = raw.data;
  return { owner, number, field: field ?? DEFAULT_BOARD_FIELD, statusMap: statusMapOf(raw.data.statusMap) };
}

// An option's name is whatever a board's editors typed, and both tables are
// plain objects, so a read by that name finds what every object inherits: an
// option called `Constructor` is `constructor` once normalised, and the table
// answered with `Object`, a function that is no status. That one status voided
// the board entry and the epic it sat in, on every run. Only an entry the table
// holds itself counts, and what it holds must still be one of the five.
function lookup(table: Readonly<Record<string, Status>>, key: string): Status | undefined {
  if (!Object.hasOwn(table, key)) return undefined;
  const status = StatusSchema.safeParse(table[key]);
  return status.success ? status.data : undefined;
}

// The status an option name stands for: the repository's map first, then the
// default table. Undefined: unmapped, so the issue keeps its derived status.
export function mapOption(project: ProjectConfig, name: string): Status | undefined {
  const key = normaliseOption(name);
  return lookup(project.statusMap, key) ?? lookup(DEFAULT_BOARD_MAP, key);
}

// Two project blocks are the same board, read the same way, whatever order the
// overrides were written in.
export function sameProject(a: ProjectConfig, b: ProjectConfig): boolean {
  const canonical = (p: ProjectConfig) => JSON.stringify([p.owner, p.number, p.field, Object.entries(p.statusMap).sort()]);
  return canonical(a) === canonical(b);
}

// A refresh the status line starts runs in a neutral directory, so it is handed
// the project block through the environment, as JSON, and checks it again, as
// the jira block is (jira-config.ts).
export const PROJECT_CONFIG_ENV = 'EPIC_PULSE_PROJECT';

export function projectToEnv(project: ProjectConfig | undefined): Record<string, string> {
  return project ? { [PROJECT_CONFIG_ENV]: JSON.stringify(project) } : {};
}

export function projectFromEnv(env: NodeJS.ProcessEnv): ProjectConfig | undefined {
  const text = env[PROJECT_CONFIG_ENV];
  if (text === undefined || text.length > 64 * 1024) return undefined;
  try {
    return parseProject(JSON.parse(text));
  } catch {
    return undefined;
  }
}
