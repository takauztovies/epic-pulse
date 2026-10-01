import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { BUNDLE, ROOT } from './helpers.js';

// What the privacy tests read about the code that ships: the bundle itself,
// and a second build that holds only what the hook can reach.

// Node's modules that open sockets or resolve names. The bundle may use none.
const NETWORK_MODULES: ReadonlySet<string> = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises']);
const SPECIFIERS = [/^import\s[^;]*?\sfrom\s*"([^"]+)"/gm, /^import\s*"([^"]+)"/gm, /\bimport\(\s*"([^"]+)"\s*\)/g, /\brequire\(\s*"([^"]+)"\s*\)/g];

export function shippedBundle(): string {
  return readFileSync(BUNDLE, 'utf8');
}

export function importsOf(text: string): readonly string[] {
  return SPECIFIERS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ''));
}

export function isNetworkModule(specifier: string): boolean {
  return NETWORK_MODULES.has(specifier.replace(/^node:/, ''));
}

// The top-level functions a source file declares, exported or not.
export function declaredFunctions(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map((match) => match[1] ?? '');
}

// esbuild appends digits to a name that clashes with another module's.
export function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\d*\\b`).test(text);
}

// Like assert.doesNotMatch, but a failure quotes the match in its context
// instead of the whole 800 KB bundle.
export function assertAbsent(text: string, pattern: RegExp, where: string): void {
  const hit = pattern.exec(text);
  const context = hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : '';
  assert.ok(hit === null, `${where} holds ${JSON.stringify(hit?.[0])}: …${context}…`);
}

export interface HookBuild {
  readonly text: string;
  // Bytes each input put into the output; tree-shaken inputs are missing.
  readonly contributions: ReadonlyMap<string, number>;
  readonly imports: readonly string[];
}

const HOOK_ENTRY = "import { runHook } from './packages/cli/src/hook.ts';\nprocess.exitCode = await runHook(process.env);\n";

// The same options as scripts/build.mjs, so esbuild drops exactly what it
// drops there, but with `runHook` as the only entry: what is left is all the
// code a hook call can run.
export async function buildHookOnly(): Promise<HookBuild> {
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { contents: HOOK_ENTRY, resolveDir: ROOT, sourcefile: 'hook-only.ts', loader: 'ts' },
    outfile: 'hook-only.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const [output] = Object.values(result.metafile.outputs);
  const [file] = result.outputFiles;
  assert.ok(output && file, 'esbuild produced no output');
  const posix = (path: string) => path.replace(/\\/g, '/');
  return {
    text: file.text,
    contributions: new Map(Object.entries(output.inputs).map(([path, input]) => [posix(path), input.bytesInOutput])),
    imports: output.imports.map((entry) => entry.path),
  };
}
