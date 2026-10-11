import {
  buildView, HookPayloadSchema, limitWarning, loadJiraFor, readingFrom, userCacheDir, warnAt, warningVariants, writeLimits, loadProgressFor, parseJson, pathsFor, pinsOf, readPins, readSession, readSnapshot, registryDirFor,
  renderStatusLine, type JiraConfig, type JsonV1,
} from '@epic-pulse/core';
import { printLine, readStdin } from './io.js';
import { readAttempt } from './refresh-attempt.js';
import { refreshDue, spawnRefresh } from './refresh-spawn.js';

// The status-line payload is a few hundred bytes.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

interface Rendered {
  readonly line: string;
  // The registry to refresh once the line is out, when something is due, and
  // the session the line is for.
  readonly refresh: { readonly dir: string; readonly session: string; readonly jira: JiraConfig | undefined } | undefined;
}

interface Origin {
  readonly dir: string;
  readonly sessionId: string | undefined;
  // The payload's `rate_limits`, as it came: limits.ts reads it.
  readonly limits: unknown;
}

// What could not be read at all renders as an error, not as a blank line.
const BROKEN: JsonV1 = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  liveSessions: 0,
  pending: 0,
  snapshot: { state: 'error', fetchedAt: null, error: null },
  epics: [],
};

// A payload without a session id belongs to no session, which the view shows
// as "hook inactive": nothing has been recorded for it.
async function readOrigin(): Promise<Origin> {
  const parsed = HookPayloadSchema.safeParse(parseJson((await readStdin(MAX_PAYLOAD_BYTES)).text));
  if (!parsed.success) return { dir: process.cwd(), sessionId: undefined, limits: undefined };
  const { workspace, cwd, session_id: sessionId, rate_limits: limits } = parsed.data;
  return { dir: workspace?.current_dir ?? cwd ?? process.cwd(), sessionId, limits };
}

const LINE_WIDTH = 80;
const WARNING_MAX = 44;

// Red unless NO_COLOR is set (https://no-color.org). Only the warning is coloured.
function paint(text: string, env: NodeJS.ProcessEnv): string {
  return env['NO_COLOR'] ? text : `\x1b[1;31m${text}\x1b[0m`;
}

// The usage warning in front of the line, at most WARNING_MAX characters, and the
// epic line fitted into what is left. The reading is saved for the prompt hook,
// which has no other way to know it; a failed save only costs the agent's note.
async function warned(origin: Origin, env: NodeJS.ProcessEnv, now: number): Promise<(line: (width: number) => string) => string> {
  const reading = readingFrom(origin.limits, now);
  const cache = userCacheDir(env);
  if (reading && cache) await writeLimits(cache, reading).catch(() => undefined);
  const warning = reading && limitWarning(reading, warnAt(env), now);
  if (!warning) return (line) => line(LINE_WIDTH);
  const variants = warningVariants(warning, now);
  const prefix = variants.find((text) => text.length <= WARNING_MAX) ?? variants.at(-1) ?? '';
  return (line) => `${paint(prefix, env)} · ${line(Math.max(8, LINE_WIDTH - prefix.length - 3))}`;
}

// Nothing is fetched here. The line comes from what is on disk; outside a
// repository there is no registry and so no epic.
async function render(env: NodeJS.ProcessEnv, now: number): Promise<Rendered> {
  const origin = await readOrigin();
  const withWarning = await warned(origin, env, now);
  const registry = await registryDirFor(origin.dir, env);
  if (registry === undefined) {
    const empty = buildView({ snapshot: { status: 'missing' }, sessions: [], pins: [], now });
    return { line: withWarning((width) => renderStatusLine(empty, { width })), refresh: undefined };
  }
  const paths = pathsFor(registry);
  const [session, snapshot, read, attempt, progress, jira] = await Promise.all([
    origin.sessionId === undefined ? undefined : readSession(paths, origin.sessionId),
    readSnapshot(paths.snapshotFile),
    readPins(paths),
    readAttempt(registry),
    loadProgressFor(origin.dir),
    loadJiraFor(origin.dir),
  ]);
  const pins = pinsOf(read);
  const view = buildView({ snapshot, sessions: session ? [session] : [], pins, now, scope: { session }, progress });
  const due = session !== undefined && refreshDue({ snapshot, session, pins, now, attempt });
  return { line: withWarning((width) => renderStatusLine(view, { width })), refresh: due ? { dir: registry, session: session.id, jira } : undefined };
}

// Never throws and never prints nothing: every outcome is one explicit line.
export async function runStatusline(env: NodeJS.ProcessEnv): Promise<number> {
  const rendered = await render(env, Date.now()).catch((): Rendered => ({ line: renderStatusLine(BROKEN), refresh: undefined }));
  printLine(rendered.line);
  if (rendered.refresh !== undefined) spawnRefresh(rendered.refresh.dir, env, { session: rendered.refresh.session, jira: rendered.refresh.jira });
  return 0;
}
