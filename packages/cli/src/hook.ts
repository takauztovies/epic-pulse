import {
  agentNote, appendRegistryLine, claimNotice, extract, fail, HookPayloadSchema, limitWarning, ok, parseJson, pathsFor, readLimits, registryDirFor,
  userCacheDir, warnAt,
  type Extraction, type HookPayload, type Result,
} from '@epic-pulse/core';
import { logHookError, type HookErrorCode } from './hook-log.js';
import { readStdin, type StdinText } from './io.js';
import { syncRuntime } from './runtime.js';

// Claude Code's payloads are small, except that a Write carries the whole file
// in its input and again in its response. Past this the payload is drained,
// not parsed, and the call is logged as too large.
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
// Under the 5 s timeout in hooks.json: the hook leaves on its own terms, with
// exit 0, instead of being killed.
const DEADLINE_MS = 4000;

function parsePayload(input: StdinText): Result<HookPayload, HookErrorCode> {
  if (input.truncated) return fail('payload_too_large');
  const parsed = HookPayloadSchema.safeParse(parseJson(input.text));
  return parsed.success ? ok(parsed.data) : fail('invalid_payload');
}

async function safeExtract(payload: HookPayload): Promise<Extraction | undefined> {
  try {
    return await extract(payload);
  } catch {
    return undefined;
  }
}

// One call, one line, even when it bound nothing: the line keeps the session
// live, and a SessionStart line is what tells the status line the hook runs.
async function record(dir: string, payload: HookPayload): Promise<Result<void, HookErrorCode>> {
  const extraction = await safeExtract(payload);
  if (!extraction) return fail('extract_failed');
  const { ev, binds, unbinds } = extraction;
  return appendRegistryLine(pathsFor(dir), payload.session_id, { v: 1, ts: Date.now(), ev, binds, unbinds });
}

// The runtime copy does not depend on being inside a repository, so it runs
// before the registry is looked up.
async function startErrors(payload: Result<HookPayload, HookErrorCode>, env: NodeJS.ProcessEnv): Promise<readonly HookErrorCode[]> {
  if (!payload.ok || payload.value.hook_event_name !== 'SessionStart') return [];
  return (await syncRuntime(env)).ok ? [] : ['runtime_copy_failed'];
}

// On a prompt, once per step of a usage window per session: the note that the
// account is near its limit, from the reading a status line saved. Anything that
// goes wrong means no note, never an error the user sees.
async function limitNote(payload: Result<HookPayload, HookErrorCode>, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!payload.ok || payload.value.hook_event_name !== 'UserPromptSubmit') return undefined;
  try {
    const cache = userCacheDir(env);
    const now = Date.now();
    const reading = cache === undefined ? undefined : await readLimits(cache, now);
    const warning = reading && limitWarning(reading, warnAt(env), now);
    if (!cache || !warning || !(await claimNotice(cache, payload.value.session_id, { ...warning, now }))) return undefined;
    return agentNote(warning, now);
  } catch {
    return undefined;
  }
}

async function handle(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const payload = parsePayload(await readStdin(MAX_PAYLOAD_BYTES));
  const note = await limitNote(payload, env);
  const errors = [...(await startErrors(payload, env))];
  const cwd = payload.ok ? (payload.value.cwd ?? payload.value.workspace?.current_dir) : undefined;
  const dir = await registryDirFor(cwd ?? process.cwd(), env);
  if (dir === undefined) return note; // not a repository: nothing to record, nowhere to log
  const recorded = payload.ok ? await record(dir, payload.value) : payload;
  if (!recorded.ok) errors.push(recorded.error);
  for (const code of errors) await logHookError(dir, code, Date.now());
  return note;
}

// Always 0, and nothing on stdout but the one documented note: Claude Code reads
// a hook's stdout as instructions and shows a failing hook to the user. Problems
// go to the log. The note is the UserPromptSubmit JSON that adds context.
export async function runHook(env: NodeJS.ProcessEnv): Promise<number> {
  const deadline = setTimeout(() => process.exit(0), DEADLINE_MS);
  deadline.unref();
  try {
    const note = await handle(env);
    if (note !== undefined) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } })}\n`);
  } catch {
    // Nowhere left to report it: stdout and stderr belong to Claude Code, and
    // a log write that failed is what usually lands here.
  } finally {
    clearTimeout(deadline);
  }
  return 0;
}
