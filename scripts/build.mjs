// Builds the one artifact the CLI and the plugin both ship: an ESM bundle of
// packages/cli with core and zod inside it, so neither has a runtime
// dependency. The plugin's copy must be byte for byte the npm one; the build
// fails if the two ever differ.
//
//   pnpm build
//
// plugin/dist is release-owned: this writes it locally, and only release/*
// branches commit it.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_OUT = join(ROOT, 'packages/cli/dist/epic-pulse.mjs');
const PLUGIN_OUT = join(ROOT, 'plugin/dist/epic-pulse.mjs');

// Unminified on purpose: users can read what runs in their hooks. A fixed
// working directory keeps the path comments esbuild writes, and so the bytes,
// the same wherever the build runs.
async function bundle() {
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['packages/cli/src/main.ts'],
    outfile: CLI_OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    minify: false,
    logLevel: 'warning',
  });
  await chmod(CLI_OUT, 0o755);
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyToPlugin() {
  await mkdir(dirname(PLUGIN_OUT), { recursive: true });
  await copyFile(CLI_OUT, PLUGIN_OUT);
  await chmod(PLUGIN_OUT, 0o755);
  const [cli, plugin] = await Promise.all([sha256(CLI_OUT), sha256(PLUGIN_OUT)]);
  if (cli !== plugin) throw new Error(`plugin/dist differs from packages/cli/dist (${plugin} != ${cli})`);
  return cli;
}

await bundle();
const digest = await copyToPlugin();
console.log(`built ${relative(ROOT, CLI_OUT)} = ${relative(ROOT, PLUGIN_OUT)} (sha256 ${digest.slice(0, 12)})`);
