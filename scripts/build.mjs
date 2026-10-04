// Builds the one artifact the CLI and the plugin both ship: an ESM bundle of
// packages/cli with core and zod inside it, so neither has a runtime
// dependency, and its THIRD_PARTY_NOTICES.md beside it. The plugin's copies
// must be byte for byte the npm ones; the build fails if they ever differ.
//
//   pnpm build
//
// plugin/dist is release-owned: this writes it locally, and only release/*
// branches commit it.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { NOTICES_FILE, noticesFor } from './notices.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_OUT = join(ROOT, 'packages/cli/dist/epic-pulse.mjs');
const PLUGIN_OUT = join(ROOT, 'plugin/dist/epic-pulse.mjs');
const CLI_NOTICES = join(dirname(CLI_OUT), NOTICES_FILE);
const PLUGIN_NOTICES = join(dirname(PLUGIN_OUT), NOTICES_FILE);

// Unminified on purpose: users can read what runs in their hooks. A fixed
// working directory keeps the path comments esbuild writes, and so the bytes,
// the same wherever the build runs. The metafile says which packages went in.
async function bundle() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['packages/cli/src/main.ts'],
    outfile: CLI_OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    minify: false,
    metafile: true,
    logLevel: 'warning',
  });
  await chmod(CLI_OUT, 0o755);
  await writeFile(CLI_NOTICES, await noticesFor(result.metafile, ROOT));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyToPlugin() {
  await mkdir(dirname(PLUGIN_OUT), { recursive: true });
  await Promise.all([copyFile(CLI_OUT, PLUGIN_OUT), copyFile(CLI_NOTICES, PLUGIN_NOTICES)]);
  await chmod(PLUGIN_OUT, 0o755);
  for (const [from, to] of [[CLI_OUT, PLUGIN_OUT], [CLI_NOTICES, PLUGIN_NOTICES]]) {
    const [cli, plugin] = await Promise.all([sha256(from), sha256(to)]);
    if (cli !== plugin) throw new Error(`${relative(ROOT, to)} differs from ${relative(ROOT, from)} (${plugin} != ${cli})`);
  }
  return sha256(CLI_OUT);
}

await bundle();
const digest = await copyToPlugin();
console.log(`built ${relative(ROOT, CLI_OUT)} = ${relative(ROOT, PLUGIN_OUT)} (sha256 ${digest.slice(0, 12)})`);
