import { describeFetchError, postGraphql, resolveToken, type RawResponse } from './github.js';
import { parsePhaseA, parsePhaseB, phaseADocument, phaseBDocument, type Failure } from './queries.js';
import { applyEpics, applyResolutions } from './refresh-apply.js';
import type { Batch } from './refresh-batch.js';
import type { Parsed, Provider } from './provider.js';
import { fail, ok, type Result } from './result.js';

// The only network call. A thrown error goes through describeFetchError's
// whitelist, never into a message: undici echoes a malformed header value,
// token included, in its error text.
async function send(token: string, batch: Batch): Promise<Result<RawResponse, Failure>> {
  const numbers = batch.refs.map((ref) => ref.number);
  const query = batch.phase === 'A' ? phaseADocument(numbers) : phaseBDocument(numbers);
  try {
    return ok(await postGraphql({ host: batch.repo.host, token, query, variables: { owner: batch.repo.owner, name: batch.repo.repo } }));
  } catch (error) {
    return fail(describeFetchError(error));
  }
}

function parse(batch: Batch, res: RawResponse): Result<Parsed, Failure> {
  if (batch.phase === 'A') {
    const parsed = parsePhaseA(res);
    if (!parsed.ok) return parsed;
    const answers = batch.refs.map((ref) => [ref, parsed.value.issues.get(ref.number) ?? null] as const);
    return ok({ rate: parsed.value.rate, apply: (snapshot, now) => applyResolutions(snapshot, answers, now) });
  }
  const parsed = parsePhaseB(res);
  if (!parsed.ok) return parsed;
  const answers = batch.refs.map((ref) => [ref, parsed.value.epics.get(ref.number) ?? null] as const);
  return ok({ rate: parsed.value.rate, apply: (snapshot, now) => applyEpics(snapshot, answers, now) });
}

export const GITHUB: Provider = {
  kind: 'github',
  token: async (host, env) => (await resolveToken(host, env))?.token,
  send,
  parse,
};
