import { readFile, stat } from 'node:fs/promises';
import { atomicWriteFile, errnoOf } from './atomic.js';
import type { RegistryPaths } from './paths.js';
import { refKey } from './ref.js';
import { fail, ok, parseJson, type Result } from './result.js';
import type { IssueRef } from './schemas/common.js';
import { PinsFileSchema, type Pin, type PinsFile } from './schemas/registry.js';

// Matches PinsFileSchema's cap, so a full list is refused here instead of
// failing validation on the next read.
const MAX_PINS = 200;
const MAX_PINS_BYTES = 256 * 1024;

export type PinsRead =
  | { readonly status: 'ok'; readonly pins: readonly Pin[] }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export type PinsErrorCode = 'corrupt' | 'full' | 'io';

export interface PinsChange {
  readonly pins: readonly Pin[];
  readonly changed: boolean;
}

export async function readPins(paths: RegistryPaths): Promise<PinsRead> {
  try {
    if ((await stat(paths.pinsFile)).size > MAX_PINS_BYTES) return { status: 'corrupt' };
    const parsed = PinsFileSchema.safeParse(parseJson(await readFile(paths.pinsFile, 'utf8')));
    return parsed.success ? { status: 'ok', pins: parsed.data.pins } : { status: 'corrupt' };
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? { status: 'missing' } : { status: 'corrupt' };
  }
}

// Readers treat an unreadable file as no pins. Only writers refuse it, so
// `track` can never silently replace pins it failed to read.
export function pinsOf(read: PinsRead): readonly Pin[] {
  return read.status === 'ok' ? read.pins : [];
}

async function writePins(paths: RegistryPaths, pins: readonly Pin[]): Promise<Result<PinsChange, PinsErrorCode>> {
  const file: PinsFile = { v: 1, pins };
  try {
    await atomicWriteFile(paths.pinsFile, `${JSON.stringify(PinsFileSchema.parse(file), null, 2)}\n`);
    return ok({ pins, changed: true });
  } catch {
    return fail('io');
  }
}

async function writablePins(paths: RegistryPaths): Promise<Result<readonly Pin[], PinsErrorCode>> {
  const read = await readPins(paths);
  return read.status === 'corrupt' ? fail('corrupt') : ok(pinsOf(read));
}

export async function addPin(paths: RegistryPaths, ref: IssueRef, now: number): Promise<Result<PinsChange, PinsErrorCode>> {
  const current = await writablePins(paths);
  if (!current.ok) return current;
  const pins = current.value;
  if (pins.some((pin) => refKey(pin.ref) === refKey(ref))) return ok({ pins, changed: false });
  if (pins.length >= MAX_PINS) return fail('full');
  return writePins(paths, [...pins, { ref, addedAt: now }]);
}

export async function removePin(paths: RegistryPaths, ref: IssueRef): Promise<Result<PinsChange, PinsErrorCode>> {
  const current = await writablePins(paths);
  if (!current.ok) return current;
  const next = current.value.filter((pin) => refKey(pin.ref) !== refKey(ref));
  return next.length === current.value.length ? ok({ pins: current.value, changed: false }) : writePins(paths, next);
}
