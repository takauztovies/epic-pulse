import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { BUNDLE, ROOT, sha256, tempDir } from './helpers.js';

// Every artifact ships THIRD_PARTY_NOTICES.md beside its bundle. The build
// derives it from esbuild's metafile; these tests read the shipped bundle
// instead, so they do not repeat that derivation.

const NOTICES = 'THIRD_PARTY_NOTICES.md';
const VSCODE = join(ROOT, 'packages', 'vscode');
const PackageSchema = z.object({ name: z.string(), version: z.string() });

// esbuild writes a `// <path>` comment over every module it puts into an
// unminified bundle, so the bundle itself says which packages it holds.
function bundledPackages(bundle: string, workingDir: string): readonly string[] {
  const paths = [...readFileSync(bundle, 'utf8').matchAll(/^\/\/ (\S*node_modules\/\S+)$/gm)].map((match) => match[1] ?? '');
  const dirs = paths.map((path) => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1]);
  return [...new Set(dirs.filter((dir) => dir !== undefined))].map((dir) => join(workingDir, dir));
}

// One section per bundled package and no other, each with the licence text
// that package ships.
function assertNoticed(notices: string, dirs: readonly string[]): void {
  assert.ok(dirs.length > 0, 'no node_modules path comment found: the pattern no longer matches esbuild output');
  const named = dirs.map((dir) => PackageSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))));
  assert.deepEqual([...notices.matchAll(/^## (.+)$/gm)].map((match) => match[1]).sort(), named.map((pkg) => `${pkg.name} ${pkg.version}`).sort());
  for (const dir of dirs) {
    const file = readdirSync(dir).find((entry) => /^licen[cs]e/i.test(entry)) ?? assert.fail(`${dir} has no licence file`);
    assert.ok(notices.includes(readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim()), `${dir}: licence text missing`);
  }
}

test('the npm package and the plugin notice every package their bundle holds, licence text and all', () => {
  const notices = join(ROOT, 'packages', 'cli', 'dist', NOTICES);
  assertNoticed(readFileSync(notices, 'utf8'), bundledPackages(BUNDLE, ROOT));
  assert.equal(sha256(join(ROOT, 'plugin', 'dist', NOTICES)), sha256(notices));
});

test('the extension notices every package its bundle holds, as its own build writes them', () => {
  const built = spawnSync(process.execPath, [join(VSCODE, 'scripts', 'build.mjs')], { cwd: VSCODE, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assertNoticed(readFileSync(join(VSCODE, 'dist', NOTICES), 'utf8'), bundledPackages(join(VSCODE, 'dist', 'extension.cjs'), VSCODE));
});

// scripts/notices.mjs in a process of its own, fed the metafile of a real
// esbuild build of a scoped package that ships no licence file.
const NOTICES_RUN = `import { readFileSync } from 'node:fs';
import { noticesFor } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'notices.mjs')).href)};
process.stdout.write(await noticesFor(JSON.parse(readFileSync(0, 'utf8')), process.argv[1]));`;

test('a bundled package without a licence file stops the build instead of going unnoticed', async (t) => {
  const dir = tempDir(t);
  const pkg = join(dir, 'node_modules', '@ep-test', 'quiet-dep');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ep-test/quiet-dep', version: '1.0.0', license: 'MIT', type: 'module', main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), 'export const quiet = 1;\n');
  writeFileSync(join(dir, 'entry.js'), "import { quiet } from '@ep-test/quiet-dep';\nconsole.log(quiet);\n");
  const { metafile } = await build({ absWorkingDir: dir, entryPoints: ['entry.js'], bundle: true, write: false, metafile: true, logLevel: 'silent' });
  const notices = () => spawnSync(process.execPath, ['--input-type=module', '-e', NOTICES_RUN, dir], { input: JSON.stringify(metafile), encoding: 'utf8' });
  const refused = notices();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /@ep-test\/quiet-dep is bundled, but \S+ holds no LICENSE file to put into THIRD_PARTY_NOTICES\.md/);
  writeFileSync(join(pkg, 'LICENSE'), 'The quiet licence.\n');
  const noticed = notices();
  assert.equal(noticed.status, 0, noticed.stderr);
  assert.match(noticed.stdout, /\n## @ep-test\/quiet-dep 1\.0\.0\n\nLicence: MIT\n\n```text\nThe quiet licence\.\n```\n$/);
});
