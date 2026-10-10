import { refKey } from './ref.js';
import type { Status, StatusCounts } from './schemas/common.js';
import type { JsonChild } from './schemas/json-v1.js';
import type { Child, EpicEntry, Snapshot } from './schemas/snapshot.js';
import type { TimeFile, TimeRef } from './schemas/time.js';
import { countStatuses } from './status.js';
import { childRefOf, MAX_TREE_DEPTH, MAX_TREE_NODES } from './tree.js';

// An epic's children as a tree, however deep: a child that has children is
// joined to the snapshot entry that holds them, and so on down. A hierarchy that
// loops back on itself, or runs past MAX_TREE_DEPTH or MAX_TREE_NODES, stops
// being followed there: that node is shown as a plain item.

export interface BoundSession {
  readonly sessionId: string;
  readonly keys: ReadonlySet<string>;
}

export interface TreeInput {
  readonly snapshot: Snapshot | undefined;
  readonly bound: readonly BoundSession[];
  readonly time: TimeFile | undefined;
  readonly iso: (ms: number) => string;
}

interface Walk {
  nodes: number;
}

// One built node: what to show, the items under it that count toward progress
// (an item with nothing under it is its own), and the key of it and of
// everything below it.
export interface Built {
  readonly json: JsonChild;
  readonly leaves: readonly Child[];
  readonly keys: readonly string[];
}

// Open work with open work under it: not started only while nothing under it
// has; otherwise under way, or in review when it says so itself. A closed one
// stays as GitHub has it.
function rolledStatus(own: Status, leaves: readonly Child[]): Status {
  if (own === 'done' || own === 'dropped') return own;
  if (leaves.every((leaf) => leaf.status === 'todo')) return own;
  return own === 'in_review' ? 'in_review' : 'in_progress';
}

function sum(timeRefs: readonly (TimeRef | undefined)[], iso: TreeInput['iso']): Pick<JsonChild, 'activeSeconds' | 'lastActivityAt' | 'lastSessionId'> {
  const present = timeRefs.filter((entry): entry is TimeRef => entry !== undefined);
  const latest = present.reduce<TimeRef | undefined>((best, entry) => (best === undefined || entry.lastTs > best.lastTs ? entry : best), undefined);
  return {
    activeSeconds: Math.floor(present.reduce((total, entry) => total + entry.ms, 0) / 1000),
    lastActivityAt: latest ? iso(latest.lastTs) : null,
    lastSessionId: latest?.lastSession ?? null,
  };
}

function toJson(child: Child, below: readonly Built[], context: { readonly keys: readonly string[]; readonly input: TreeInput }): JsonChild {
  const { input } = context;
  const all = [...new Set(context.keys)];
  const sessionIds = input.bound.filter((session) => all.some((key) => session.keys.has(key))).map((session) => session.sessionId);
  const leaves = below.flatMap((node) => node.leaves);
  const assignees = [...new Set([...(child.assignees ?? []), ...leaves.flatMap((leaf) => leaf.assignees ?? [])])].slice(0, 5);
  const counts: StatusCounts | null = below.length === 0 ? null : countStatuses(leaves);
  const shown = counts === null ? null : Math.floor((counts.done * 100) / Math.max(1, leaves.length - counts.dropped));
  return {
    number: child.number,
    key: child.key ?? (child.number === null ? null : `#${child.number}`),
    title: child.title,
    url: child.url,
    status: below.length === 0 ? child.status : rolledStatus(child.status, leaves),
    subCount: child.subCount ?? 0,
    sessionCount: sessionIds.length,
    sessionIds,
    assignees,
    openPullRequests: (child.openPrs ?? 0) + below.reduce((total, node) => total + node.json.openPullRequests, 0),
    ...sum(all.map((key) => input.time?.refs[key]), input.iso),
    counts,
    percent: shown,
    children: below.map((node) => node.json),
  };
}

function build(child: Child, entry: EpicEntry, context: { readonly input: TreeInput; readonly trail: ReadonlySet<string>; readonly walk: Walk }): Built {
  const { input, trail, walk } = context;
  walk.nodes += 1;
  const ref = childRefOf(child, entry.ref);
  const key = ref === undefined ? undefined : refKey(ref);
  const sub = key === undefined || trail.has(key) || trail.size > MAX_TREE_DEPTH || walk.nodes >= MAX_TREE_NODES || child.status === 'dropped' ? undefined : input.snapshot?.epics[key];
  const below = sub === undefined || key === undefined ? [] : sub.children.map((inner) => build(inner, sub, { input, trail: new Set([...trail, key]), walk }));
  const keys = [...(key === undefined ? [] : [key]), ...below.flatMap((node) => node.keys)];
  const json = toJson(child, below, { keys, input });
  return { json, leaves: below.length === 0 ? [child] : below.flatMap((node) => node.leaves), keys };
}

export function buildChildren(entry: EpicEntry, input: TreeInput): readonly Built[] {
  const walk: Walk = { nodes: 0 };
  const trail = new Set([refKey(entry.ref)]);
  return entry.children.map((child) => build(child, entry, { input, trail, walk }));
}

