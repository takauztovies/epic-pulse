// Builds the VS Code extension: one CommonJS file with core and zod inside
// it. `vscode` is not a package; the extension host provides it at run time.
//
//   pnpm --filter ./packages/vscode build
//
// Unminified, like the CLI bundle: the code that holds your GitHub token stays
// readable in the installed extension. A fixed working directory keeps the
// path comments esbuild writes, and so the bytes, the same wherever it runs.
import { build } from 'esbuild';
import { URL, fileURLToPath } from 'node:url';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const OUT = 'dist/extension.cjs';

await build({
  absWorkingDir: PACKAGE,
  entryPoints: ['src/extension.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.90, the oldest engine the manifest allows, runs Node 20.
  target: 'node20',
  external: ['vscode'],
  minify: false,
  logLevel: 'warning',
});
console.log(`built packages/vscode/${OUT}`);
