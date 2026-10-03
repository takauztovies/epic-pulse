import { appendFile, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from './atomic.js';
import type { RegistryPaths } from './paths.js';
import { refKey } from './ref.js';
import { fail, ok, parseJson, type Result } from './result.js';
import type { BindVia, IssueRef } from './schemas/common.js';
import { SESSION_ID_PATTERN } from './schemas/hook.js';
import { RegistryLineSchema, type RegistryLine, type RegistryLineInput } from './schemas/registry.js';

export const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const BINDING_TTL_MS = 6 * 60 * 60 * 1000;
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// A line the hook writes holds at most three refs and stays far below this.
// Anything larger is refused: a single append is only whole-line atomic when
// it is small (4 KiB is Linux's PIPE_BUF).
const MAX_LINE_BYTES = 4096;
// The status line reads session files on every render. Past this size only
// the tail is read; the torn first line of the tail is skipped like any other.
const MAX_READ_BYTES = 2 * 1024 * 1024;
const SESSION_SUFFIX = '.jsonl';

export type RegistryErrorCode = 'invalid_session' | 'invalid_line' | 'line_too_large' | 'io';

export interface Binding {
  readonly ref: IssueRef;
  readonly via: BindVia;
  readonly ts: number;
}

export interface SessionState {
  readonly id: string;
  readonly lastTs: number;
  readonly ended: boolean;
  readonly bindings: readonly Binding[];
}

// The id becomes a file name, so it is checked before any path is built.
export function sessionFile(paths: RegistryPaths, sessionId: string): string | undefined {
  return SESSION_ID_PATTERN.test(sessionId) ? join(paths.sessionsDir, `${sessionId}${SESSION_SUFFIX}`) : undefined;
}

// One hook call, one line, one append. `appendFile` opens with O_APPEND and a
// buffer this small goes out in one write, so concurrent hooks of the same
// session interleave whole lines, never bytes.
export async function appendRegistryLine(
  paths: RegistryPaths,
  sessionId: string,
  line: RegistryLineInput,
): Promise<Result<void, RegistryErrorCode>> {
  const file = sessionFile(paths, sessionId);
  if (!file) return fail('invalid_session');
  const parsed = RegistryLineSchema.safeParse(line);
  if (!parsed.success) return fail('invalid_line');
  const text = `${JSON.stringify(parsed.data)}\n`;
  if (Buffer.byteLength(text) > MAX_LINE_BYTES) return fail('line_too_large');
  try {
    await ensureDir(paths.sessionsDir);
    await appendFile(file, text, { mode: 0o600 });
    return ok(undefined);
  } catch {
    return fail('io');
  }
}

// A torn tail (a hook killed mid-write), a line from a newer version or a hand
// edit is skipped; every other line still counts.
export function parseLines(text: string): readonly RegistryLine[] {
  return text.split('\n').flatMap((raw) => {
    const parsed = RegistryLineSchema.safeParse(parseJson(raw));
    return parsed.success ? [parsed.data] : [];
  });
}

// Lines apply in time order (a stable sort keeps file order for ties): a bind
// refreshes the binding, an unbind removes it. A pin stays a pin when a weaker
// signal later sees the same issue, so it keeps its exemption from the TTL.
// An unbind also keeps every later non-pin bind of that issue out for the rest
// of the session; without that, `untrack` on a branch-bound issue was undone
// by the next edit in its worktree. Only a pin (`track`) lets it back in.
// A session has ended when an end line is later than its latest start. The
// last line is not the test: PostToolUse runs asynchronously, so one that was
// still starting when the session ended writes a line stamped after the end,
// and reading that as activity brought the ended session back to life for two
// hours. Resuming a session writes a new start, which does.
export function foldSession(id: string, lines: readonly RegistryLine[]): SessionState | undefined {
  const ordered = [...lines].sort((a, b) => a.ts - b.ts);
  const last = ordered.at(-1);
  if (!last) return undefined;
  const bindings = new Map<string, Binding>();
  const untracked = new Set<string>();
  for (const line of ordered) {
    for (const bind of line.binds) {
      const key = refKey(bind.ref);
      if (bind.via === 'pin') untracked.delete(key);
      if (untracked.has(key)) continue;
      const via = bindings.get(key)?.via === 'pin' ? 'pin' : bind.via;
      bindings.set(key, { ref: bind.ref, via, ts: line.ts });
    }
    for (const ref of line.unbinds) {
      bindings.delete(refKey(ref));
      untracked.add(refKey(ref));
    }
  }
  return { id, lastTs: last.ts, ended: latest(ordered, 'end') > latest(ordered, 'start'), bindings: [...bindings.values()] };
}

// The time of the latest line of this kind, or minus infinity when there is none.
function latest(lines: readonly RegistryLine[], ev: RegistryLine['ev']): number {
  return lines.reduce((best, line) => (line.ev === ev ? Math.max(best, line.ts) : best), Number.NEGATIVE_INFINITY);
}

export function isLive(session: SessionState, now: number): boolean {
  return !session.ended && now - session.lastTs <= LIVE_WINDOW_MS;
}

// A binding lapses six hours after the last call that saw it; an explicit pin
// lasts until it is untracked or the session ends.
export function activeBindings(session: SessionState, now: number): readonly Binding[] {
  return session.bindings.filter((binding) => binding.via === 'pin' || now - binding.ts <= BINDING_TTL_MS);
}

// The SessionStart hook writes a line before the first status line renders,
// so a session with no line at all means the hook is not running for it:
// plugin not enabled, or no Node to run it.
export function isHookInactive(session: SessionState | undefined): boolean {
  return session === undefined;
}

export async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_READ_BYTES);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readSession(paths: RegistryPaths, sessionId: string): Promise<SessionState | undefined> {
  const file = sessionFile(paths, sessionId);
  if (!file) return undefined;
  const text = await readTail(file).catch(() => ''); // no file yet, or unreadable
  return foldSession(sessionId, parseLines(text));
}

interface SessionFile {
  readonly id: string;
  readonly file: string;
  readonly mtimeMs: number;
}

async function sessionFiles(paths: RegistryPaths): Promise<readonly SessionFile[]> {
  const names = await readdir(paths.sessionsDir).catch(() => [] as string[]);
  const found = await Promise.all(
    names.map(async (name) => {
      const id = name.endsWith(SESSION_SUFFIX) ? name.slice(0, -SESSION_SUFFIX.length) : '';
      const file = sessionFile(paths, id);
      const info = file ? await stat(file).catch(() => undefined) : undefined;
      return file && info?.isFile() ? [{ id, file, mtimeMs: info.mtimeMs }] : [];
    }),
  );
  return found.flat();
}

// A line's ts is taken before it is appended, so a file untouched for the
// whole live window holds no live line and is not even opened.
export async function readLiveSessions(paths: RegistryPaths, now: number): Promise<readonly SessionState[]> {
  const recent = (await sessionFiles(paths)).filter((entry) => now - entry.mtimeMs <= LIVE_WINDOW_MS);
  const sessions = await Promise.all(recent.map((entry) => readSession(paths, entry.id)));
  return sessions.filter((session): session is SessionState => session !== undefined && isLive(session, now));
}

// Session files untouched for a week are deleted. Returns how many were.
export async function pruneSessions(paths: RegistryPaths, now: number): Promise<number> {
  const stale = (await sessionFiles(paths)).filter((entry) => now - entry.mtimeMs > PRUNE_AFTER_MS);
  const removed = await Promise.all(stale.map((entry) => unlink(entry.file).then(() => true, () => false)));
  return removed.filter(Boolean).length;
}
