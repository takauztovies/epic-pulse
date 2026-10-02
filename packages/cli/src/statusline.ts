import {
  buildView, HookPayloadSchema, parseJson, pathsFor, pinsOf, readPins, readSession, readSnapshot, registryDirFor,
  renderStatusLine, type JsonV1,
} from '@epic-pulse/core';
import { printLine, readStdin } from './io.js';
import { readAttempt } from './refresh-attempt.js';
import { refreshDue, spawnRefresh } from './refresh-spawn.js';

// The status-line payload is a few hundred bytes.
const MAX_PAYLOAD_BYTES = 1024 * 1024;

interface Rendered {
  readonly line: string;
  // The registry to refresh once the line is out, when something is due.
  readonly refresh: string | undefined;
}

interface Origin {
  readonly dir: string;
  readonly sessionId: string | undefined;
}

// What could not be read at all renders as an error, not as a blank line.
const BROKEN: JsonV1 = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  liveSessions: 0,
  snapshot: { state: 'error', fetchedAt: null, error: null },
  epics: [],
};

// A payload without a session id belongs to no session, which the view shows
// as "hook inactive": nothing has been recorded for it.
async function readOrigin(): Promise<Origin> {
  const parsed = HookPayloadSchema.safeParse(parseJson((await readStdin(MAX_PAYLOAD_BYTES)).text));
  if (!parsed.success) return { dir: process.cwd(), sessionId: undefined };
  const { workspace, cwd, session_id: sessionId } = parsed.data;
  return { dir: workspace?.current_dir ?? cwd ?? process.cwd(), sessionId };
}

// Nothing is fetched here. The line comes from what is on disk; outside a
// repository there is no registry and so no epic.
async function render(env: NodeJS.ProcessEnv, now: number): Promise<Rendered> {
  const origin = await readOrigin();
  const registry = await registryDirFor(origin.dir, env);
  if (registry === undefined) {
    return { line: renderStatusLine(buildView({ snapshot: { status: 'missing' }, sessions: [], pins: [], now })), refresh: undefined };
  }
  const paths = pathsFor(registry);
  const [session, snapshot, read, attempt] = await Promise.all([
    origin.sessionId === undefined ? undefined : readSession(paths, origin.sessionId),
    readSnapshot(paths.snapshotFile),
    readPins(paths),
    readAttempt(registry),
  ]);
  const pins = pinsOf(read);
  const view = buildView({ snapshot, sessions: session ? [session] : [], pins, now, scope: { session } });
  return { line: renderStatusLine(view), refresh: refreshDue({ snapshot, session, pins, now, attempt }) ? registry : undefined };
}

// Never throws and never prints nothing: every outcome is one explicit line.
export async function runStatusline(env: NodeJS.ProcessEnv): Promise<number> {
  const rendered = await render(env, Date.now()).catch((): Rendered => ({ line: renderStatusLine(BROKEN), refresh: undefined }));
  printLine(rendered.line);
  if (rendered.refresh !== undefined) spawnRefresh(rendered.refresh, env);
  return 0;
}
