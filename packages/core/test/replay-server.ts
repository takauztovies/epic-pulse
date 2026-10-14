import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { API_BASE_TEST_ENV, apiUrl, type RawResponse } from '../src/github.js';
import { parseJson } from '../src/result.js';

// A real node:http server on 127.0.0.1 that answers github.com's GraphQL
// endpoint with responses recorded in fixtures/graphql, so the real fetch, the
// real parse and the real paging loop run as they do against GitHub and only the
// address differs. It is the one server these tests are allowed (the owner's
// decision: the board's page cap and its rate-limit path can not be seen offline
// any other way) and it decides nothing: it hands back what `reply` gives it, the
// recorded body re-serialised as the recorder stored it, with the status and the
// two rate-limit headers the recording carries, and it keeps what it was asked.
// Nothing here is a token: the Authorization header is never read.

export interface ReplayedRequest {
  // Where this request came in the order of arrival, from 0.
  readonly index: number;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

export interface Replay {
  // Every request so far, in the order it came.
  readonly requests: readonly ReplayedRequest[];
}

const BodySchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// What the client sent; a body that is not `{ query, variables }` is kept as an
// empty request, so the count of requests stays true.
function requestOf(text: string, index: number): ReplayedRequest {
  const body = BodySchema.safeParse(parseJson(text));
  return { index, ...(body.success ? body.data : { query: '', variables: {} }) };
}

function answer(res: ServerResponse, recorded: RawResponse): void {
  res.writeHead(recorded.status, {
    'content-type': 'application/json',
    ...(recorded.remaining === undefined ? {} : { 'x-ratelimit-remaining': String(recorded.remaining) }),
    ...(recorded.retryAfter ? { 'retry-after': '60' } : {}),
  });
  res.end(JSON.stringify(recorded.body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

// fetch keeps its connections open, and close() waits for them.
function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function restore(previous: string | undefined): void {
  if (previous === undefined) delete process.env[API_BASE_TEST_ENV];
  else process.env[API_BASE_TEST_ENV] = previous;
}

// Starts the server, points github.com's endpoint at it for the rest of the
// test (the variable is put back, and the server stopped, when the test ends),
// and refuses to go on unless the endpoint really moved: a seam that silently
// did nothing would send the test's requests to GitHub, or let a test that
// expects no request pass without ever having been able to see one.
export async function replayServer(t: TestContext, reply: (request: ReplayedRequest) => RawResponse): Promise<Replay> {
  let seen: readonly ReplayedRequest[] = [];
  const server = createServer((req, res) => {
    void readText(req).then((text) => {
      const request = requestOf(text, seen.length);
      seen = [...seen, request];
      answer(res, reply(request));
    });
  });
  const origin = await listen(server);
  const previous = process.env[API_BASE_TEST_ENV];
  process.env[API_BASE_TEST_ENV] = origin;
  t.after(async () => {
    restore(previous);
    await stop(server);
  });
  assert.equal(apiUrl('github.com'), `${origin}/graphql`, 'github.com is not pointed at the replay server');
  return { get requests() { return seen; } };
}
