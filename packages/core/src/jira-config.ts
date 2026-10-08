import { HostSchema, type Status, STATUSES } from './schemas/common.js';

// The `jira` block of `.epic-pulse.json`: which Jira Cloud site and projects
// this repository's work is tracked in, and how its workflow maps onto the
// five statuses. The file is untrusted, so every field is checked and a bad one
// is dropped. It says WHERE the keys belong; it never decides where a
// credential goes: that is JIRA_SITE in the user's own environment (jira.ts).
export interface JiraConfig {
  readonly site: string;
  readonly projects: readonly string[];
  // Status name (lowercased) to the lane it counts as, over the status
  // category Jira reports.
  readonly statusMap: Readonly<Record<string, Status>>;
  // Resolution names (lowercased) that mean "decided not to do it".
  readonly droppedResolutions: readonly string[];
}

export const JIRA_LIMITS = { maxProjects: 20, maxStatusMap: 60, maxDropped: 20, maxNameLength: 80 } as const;

// What Jira's own resolutions call work that was decided against.
export const DEFAULT_DROPPED: readonly string[] = ["won't do", "won't fix", 'duplicate', 'declined', 'rejected', 'cannot reproduce', 'invalid', 'obsolete'];

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectsOf(value: unknown): readonly string[] {
  const keys = (Array.isArray(value) ? value : []).flatMap((entry) => {
    const key = typeof entry === 'string' ? entry.trim().toUpperCase() : '';
    return PROJECT_KEY.test(key) ? [key] : [];
  });
  return [...new Set(keys)].slice(0, JIRA_LIMITS.maxProjects);
}

function statusMapOf(value: unknown): Readonly<Record<string, Status>> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).flatMap(([name, lane]) => {
    const key = name.trim().toLowerCase();
    const known = (STATUSES as readonly unknown[]).includes(lane) ? (lane as Status) : undefined;
    return key.length > 0 && key.length <= JIRA_LIMITS.maxNameLength && known ? [[key, known] as const] : [];
  });
  return Object.fromEntries(entries.slice(0, JIRA_LIMITS.maxStatusMap));
}

function droppedOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_DROPPED;
  const names = value.flatMap((entry) => (typeof entry === 'string' && entry.trim().length > 0 && entry.length <= JIRA_LIMITS.maxNameLength ? [entry.trim().toLowerCase()] : []));
  return names.length === 0 ? DEFAULT_DROPPED : [...new Set(names)].slice(0, JIRA_LIMITS.maxDropped);
}

// Undefined without a valid site and at least one project: nothing is Jira.
export function parseJira(value: unknown): JiraConfig | undefined {
  if (!isRecord(value) || typeof value['site'] !== 'string') return undefined;
  const site = value['site'].trim().toLowerCase();
  const projects = projectsOf(value['projects']);
  if (!HostSchema.safeParse(site).success || projects.length === 0) return undefined;
  return { site, projects, statusMap: statusMapOf(value['statusMap']), droppedResolutions: droppedOf(value['droppedResolutions']) };
}
