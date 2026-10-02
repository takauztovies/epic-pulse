import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { BUNDLE, ROOT, sha256 } from './helpers.js';

const PLUGIN_BUNDLE = join(ROOT, 'plugin', 'dist', 'epic-pulse.mjs');
const SPECIFIERS = [/^import\s[^;]*?\sfrom\s*"([^"]+)"/gm, /^import\s*"([^"]+)"/gm, /\bimport\(\s*"([^"]+)"\s*\)/g, /\brequire\(\s*"([^"]+)"\s*\)/g];

test('the npm package and the plugin ship the same bytes', () => {
  assert.equal(sha256(PLUGIN_BUNDLE), sha256(BUNDLE));
});

test('the bundle is an unminified Node ESM script that loads nothing but Node built-ins', () => {
  const text = readFileSync(BUNDLE, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  const specifiers = SPECIFIERS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ''));
  assert.ok(specifiers.length > 0, 'no import found at all: the pattern no longer matches esbuild output');
  assert.deepEqual(specifiers.filter((specifier) => !isBuiltin(specifier)), []);
  assert.match(text, /\nfunction mergeStatusLine\(/);
  assert.ok(Buffer.from(text, 'utf8').equals(readFileSync(BUNDLE)), 'the runtime copy relies on an exact UTF-8 round trip');
});

test('the npm package declares no runtime dependency and ships only dist: the bundle and its notices', () => {
  const cli = z.looseObject({ name: z.string(), bin: z.record(z.string(), z.string()), files: z.array(z.string()) })
    .parse(JSON.parse(readFileSync(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')));
  assert.deepEqual([cli.name, cli.bin, cli.files], ['epic-pulse', { 'epic-pulse': 'dist/epic-pulse.mjs' }, ['dist']]);
  assert.deepEqual(['dependencies', 'peerDependencies', 'optionalDependencies'].filter((key) => key in cli), []);
});
