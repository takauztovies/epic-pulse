import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, fail, ok, type Result } from '@epic-pulse/core';
import { runtimeFile } from './claude-home.js';

export type RuntimeState = 'missing' | 'current' | 'outdated';
export type SyncOutcome = 'copied' | 'unchanged';

// The file this code is running from: the bundle, whether it was started as
// the npm bin, from the plugin's dist or as the runtime copy itself.
export function bundlePath(): string {
  return fileURLToPath(import.meta.url);
}

export async function runtimeState(env: NodeJS.ProcessEnv): Promise<RuntimeState> {
  const [own, copy] = await Promise.all([readFile(bundlePath()), readFile(runtimeFile(env)).catch(() => undefined)]);
  if (copy === undefined) return 'missing';
  return copy.equals(own) ? 'current' : 'outdated';
}

// Copies this bundle to the stable runtime path unless an identical copy is
// already there, so on most session starts this costs two reads. esbuild
// writes valid UTF-8 (ASCII outside comments), so the text round trip that
// core's atomic write needs is exact.
export async function syncRuntime(env: NodeJS.ProcessEnv): Promise<Result<SyncOutcome, 'io'>> {
  try {
    const target = runtimeFile(env);
    const [own, copy] = await Promise.all([readFile(bundlePath()), readFile(target).catch(() => undefined)]);
    if (copy?.equals(own)) return ok('unchanged');
    await atomicWriteFile(target, own.toString('utf8'));
    return ok('copied');
  } catch {
    return fail('io');
  }
}
