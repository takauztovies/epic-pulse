// Fallible operations return a value instead of throwing so every caller has to
// look at the failure. `E` is a plain data object, never an Error, which keeps
// stack traces and library messages out of anything that is persisted.
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// JSON.parse returns `any`; funnelling it through here keeps that `any` from
// leaking into typed code and makes "not JSON" an explicit undefined.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
