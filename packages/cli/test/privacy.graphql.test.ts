import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '@epic-pulse/core';
import { assertAbsent, shippedBundle } from './privacy-bundle.js';

// epic-pulse only ever reads from GitHub. Every document is a query: one
// that starts with `query` and nowhere spells `mutation` or `subscription`.

type DocumentBuilder = (numbers: readonly number[]) => unknown;

const SAMPLES: readonly (readonly number[])[] = [[1], [4, 8, 9999], Array.from({ length: 100 }, (_, i) => i + 1)];
const WRITE_KEYWORDS = /\b(?:mutation|subscription)\b/;

function isBuilder(value: unknown): value is DocumentBuilder {
  return typeof value === 'function';
}

// Found by name, so a builder core adds later is held to this too.
function builders(): readonly (readonly [string, DocumentBuilder])[] {
  return Object.entries(core).flatMap(([name, value]) => (name.endsWith('Document') && isBuilder(value) ? [[name, value] as const] : []));
}

test('every GraphQL document core can build is a query, never a mutation or subscription', () => {
  const found = builders();
  assert.ok(found.length >= 2, `found ${found.length} document builders in core, so the scan no longer sees them`);
  for (const [name, build] of found) {
    for (const numbers of SAMPLES) {
      const document = build(numbers);
      assert.ok(typeof document === 'string', `${name} returned no string`);
      assert.match(document, /^query \w+\(/, name);
      assert.doesNotMatch(document, WRITE_KEYWORDS, name);
    }
  }
});

// A document built anywhere else in the shipped code, CLI included, is a
// string in the bundle too.
test('the shipped bundle spells no GraphQL mutation or subscription anywhere', () => {
  const text = shippedBundle();
  assert.ok(text.includes('query PhaseA('), 'the bundle holds no query either, so the scan reads the wrong file');
  assertAbsent(text, WRITE_KEYWORDS, 'the bundle');
});
