import { z } from 'zod';

// Claude Code writes UUIDs. The id becomes a file name under the registry, so
// anything else (`../x`, absolute paths, NUL) is rejected before it can be used
// to write outside that directory.
export const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;
export const SessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

// Hook and status-line payloads are parsed leniently: unknown keys pass through
// (Claude Code adds fields between releases) and only what we read is typed.
// Nothing but the `Extraction` extract.ts derives from a payload (the event
// and issue refs) is ever kept, so file contents in `tool_input.content` can
// not leak into the registry.
const ToolInputSchema = z.looseObject({
  command: z.string().optional().catch(undefined),
  file_path: z.string().optional().catch(undefined),
  notebook_path: z.string().optional().catch(undefined),
});

export const HookPayloadSchema = z.looseObject({
  session_id: z.string(),
  cwd: z.string().optional().catch(undefined),
  hook_event_name: z.string().optional().catch(undefined),
  tool_name: z.string().optional().catch(undefined),
  tool_input: ToolInputSchema.optional().catch(undefined),
  // Read by the status line only (limits.ts), and never stored as it came.
  rate_limits: z.unknown().optional(),
  workspace: z
    .looseObject({ current_dir: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export type HookPayload = z.infer<typeof HookPayloadSchema>;
