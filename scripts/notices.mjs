// Third-party notices for a bundle, derived from esbuild's metafile rather
// than a list kept by hand: every package under node_modules that put code
// into the output, with its version, its licence and the licence text it
// ships. This workspace's own packages are never under node_modules, and are
// MIT like epic-pulse itself.
//
// Used by scripts/build.mjs (the CLI and plugin bundle) and
// packages/vscode/scripts/build.mjs (the extension).
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:[.-][^/]*)?$/i;

const HEADER = `# Third-party notices

The bundle next to this file contains the packages below, which are not part
of epic-pulse. Each keeps its own licence, reproduced here as the package
ships it. epic-pulse itself is MIT licensed.
`;

// `node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js` names the
// directory of the last package on its path: `.../node_modules/zod`.
function packageDir(input) {
  const parts = input.replaceAll('\\', '/').split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at === -1 || parts[at + 1] === undefined) return undefined;
  return parts.slice(0, at + (parts[at + 1].startsWith('@') ? 3 : 2)).join('/');
}

// Only inputs that put bytes into an output count: a module esbuild dropped
// entirely ships nothing.
function bundledDirs(metafile) {
  const inputs = Object.values(metafile.outputs).flatMap((output) => Object.entries(output.inputs));
  const dirs = inputs.filter(([, input]) => input.bytesInOutput > 0).map(([path]) => packageDir(path));
  return [...new Set(dirs.filter((dir) => dir !== undefined))];
}

// A package without a licence file can not be noticed, so the build stops
// rather than ship a bundle whose notices leave it out.
async function licenceText(dir, name) {
  const file = (await readdir(dir)).filter((entry) => LICENCE_FILE.test(entry)).sort()[0];
  if (file === undefined) throw new Error(`${name} is bundled, but ${dir} holds no LICENSE file to put into ${NOTICES_FILE}`);
  return (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n').trim();
}

async function describe(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, license: manifest.license, text: await licenceText(dir, manifest.name) };
}

// A fence longer than any run of backticks in the text it holds.
function section(pkg) {
  const fence = '`'.repeat(Math.max(2, ...[...pkg.text.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  return [`## ${pkg.name} ${pkg.version}`, '', `Licence: ${pkg.license ?? 'see the text below'}`, '', `${fence}text`, pkg.text, fence, ''].join('\n');
}

// Code-unit order, not the locale's: the file is byte-identical everywhere.
function byNameThenVersion(a, b) {
  const left = `${a.name}\u0000${a.version}`;
  const right = `${b.name}\u0000${b.version}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

// `workingDir` is the build's absWorkingDir, which the metafile's paths are
// relative to, except where esbuild has no relative path to give (a package on
// another drive on Windows): that one it names absolutely, and `join` would
// append such a path to the working directory instead of reading it.
export async function noticesFor(metafile, workingDir) {
  const packages = await Promise.all(bundledDirs(metafile).map((dir) => describe(resolve(workingDir, dir))));
  return [HEADER, ...packages.sort(byNameThenVersion).map(section)].join('\n');
}
