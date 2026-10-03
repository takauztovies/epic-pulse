// Cuts a release branch: every manifest gets the one version, the bundle is
// rebuilt, and the manifests plus plugin/dist are committed on
// release/v<version>. Nothing is pushed or tagged; the next steps are printed.
//
//   node scripts/release.mjs 0.2.0            cut release/v0.2.0 from main
//   node scripts/release.mjs --check v0.2.0   exit 1 unless every manifest says 0.2.0
//                                             and the marketplace installs v0.2.0
//
// plugin/dist is ignored everywhere but on release branches, so it is added
// with -f: Claude Code fetches the plugin's directory from the release tag as
// it is, and this is the copy it runs. release.yml runs --check against the tag.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE_BRANCH = 'main';
const PLUGIN_DIST = 'plugin/dist';
// Stable versions only: the VS Code Marketplace refuses a pre-release suffix.
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_FIELD = /"version"(\s*):(\s*)"[^"]*"/g;
const REF_FIELD = /"ref"(\s*):(\s*)"[^"]*"/g;

const pluginEntry = (json) => json.plugins?.find((plugin) => plugin.name === 'epic-pulse');
const tagOf = (version) => `v${version}`;

// Each manifest that carries the version, and where in it the version is.
// The marketplace entry also names the tag the plugin is installed from, the
// `ref` of its git-subdir source, which is always the release tag: a plugin
// user gets a release, never main. `claude plugin validate` lets a misspelt key
// there through, and a source without a `ref` installs from main, so this
// script is what holds it. The extension's manifest is there only once
// packages/vscode exists.
const MANIFESTS = [
  { path: 'packages/cli/package.json', read: (json) => json.version },
  { path: 'plugin/.claude-plugin/plugin.json', read: (json) => json.version },
  { path: '.claude-plugin/marketplace.json', read: (json) => pluginEntry(json)?.version, readRef: (json) => pluginEntry(json)?.source?.ref },
  { path: 'packages/vscode/package.json', read: (json) => json.version, optional: true },
];

class ReleaseError extends Error {}

// Only the final newline goes: porcelain output starts lines with a space.
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
}

function gitSucceeds(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(text) {
  const match = VERSION.exec(text ?? '');
  return match ? { text: match.slice(1).join('.'), parts: match.slice(1).map(Number) } : undefined;
}

function isNewer(next, current) {
  const [a, b] = [next.parts, parseVersion(current)?.parts ?? [0, 0, 0]];
  const differing = a.findIndex((part, i) => part !== b[i]);
  return differing !== -1 && a[differing] > b[differing];
}

function presentManifests() {
  return MANIFESTS.filter((manifest) => !manifest.optional || existsSync(join(ROOT, manifest.path)));
}

function manifestVersion(manifest) {
  return manifest.read(JSON.parse(readFileSync(join(ROOT, manifest.path), 'utf8')));
}

// Only the field's value changes, so every file keeps its own layout. The
// result is read back to prove that the edited field is the one that counts.
function withField(text, field, value) {
  const found = text.match(field.pattern) ?? [];
  if (found.length !== 1) throw new ReleaseError(`${field.path} has ${found.length} "${field.name}" fields, expected exactly one`);
  const next = text.replace(field.pattern, `"${field.name}"$1:$2"${value}"`);
  if (field.read(JSON.parse(next)) !== value) throw new ReleaseError(`${field.path}: the "${field.name}" field is not where its ${field.what} is read`);
  return next;
}

function bumpedText(manifest, version) {
  const text = readFileSync(join(ROOT, manifest.path), 'utf8');
  const bumped = withField(text, { path: manifest.path, name: 'version', what: 'version', pattern: VERSION_FIELD, read: manifest.read }, version);
  if (!manifest.readRef) return bumped;
  return withField(bumped, { path: manifest.path, name: 'ref', what: 'tag', pattern: REF_FIELD, read: manifest.readRef }, tagOf(version));
}

// The tree must hold nothing but what is committed. plugin/dist is the one
// exception: once a release has tracked it, every build rewrites it, and the
// build below rewrites it again anyway.
function assertReadyToCut(version) {
  const branch = `release/v${version.text}`;
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== BASE_BRANCH) throw new ReleaseError(`releases are cut from ${BASE_BRANCH}, and this is ${current}`);
  const dirty = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter((entry) => entry && !entry.slice(3).startsWith(`${PLUGIN_DIST}/`));
  if (dirty.length > 0) throw new ReleaseError(`commit or stash these first:\n${dirty.join('\n')}`);
  if (gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) throw new ReleaseError(`the branch ${branch} already exists`);
  if (gitSucceeds(['rev-parse', '--verify', '--quiet', `refs/tags/v${version.text}`])) throw new ReleaseError(`the tag v${version.text} already exists`);
  const stale = presentManifests().filter((manifest) => !isNewer(version, manifestVersion(manifest)));
  if (stale.length > 0) throw new ReleaseError(`${version.text} is not newer than ${stale.map((m) => `${m.path} (${manifestVersion(m)})`).join(', ')}`);
}

// Everything that can be refused is, before anything changes.
function plan(version) {
  assertReadyToCut(version);
  const manifests = presentManifests().map((manifest) => ({ path: manifest.path, text: bumpedText(manifest, version.text) }));
  return { version, branch: `release/v${version.text}`, manifests };
}

function cut(planned) {
  git(['switch', '--quiet', '--create', planned.branch]);
  for (const manifest of planned.manifests) writeFileSync(join(ROOT, manifest.path), manifest.text);
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  git(['add', '--', ...planned.manifests.map((manifest) => manifest.path)]);
  git(['add', '--force', '--', PLUGIN_DIST]);
  git(['commit', '--quiet', '--message', `chore: release v${planned.version.text}`]);
  return planned.branch;
}

function nextSteps(version, branch) {
  const tag = `v${version.text}`;
  return [
    `epic-pulse: ${branch} is ready (${git(['rev-parse', '--short', 'HEAD'])} chore: release ${tag}). Nothing was pushed.`,
    'Next:',
    `  1. git push -u origin ${branch}`,
    `  2. gh pr create --base ${BASE_BRANCH} --head ${branch} --title "chore: release ${tag}" --body "Release ${tag}."`,
    `  3. once it is merged: git switch ${BASE_BRANCH} && git pull --ff-only`,
    `  4. git tag -a ${tag} -m ${tag} && git push origin ${tag}`,
    '     The tag starts .github/workflows/release.yml, which waits for approval in the release environment.',
  ].join('\n');
}

function refComplaint(path, ref, tag) {
  return ref === undefined ? `${path} pins no tag, so it installs the plugin from main` : `${path} installs the plugin from ${ref}, not from ${tag}`;
}

// What a manifest gets wrong about this version: the version it says and, for
// the marketplace entry, the tag it installs the plugin from.
function mismatches(manifest, version) {
  const json = JSON.parse(readFileSync(join(ROOT, manifest.path), 'utf8'));
  const [found, ref, tag] = [manifest.read(json), manifest.readRef?.(json), tagOf(version)];
  return [
    ...(found === version ? [] : [`${manifest.path} says ${found}, not ${version}`]),
    ...(manifest.readRef === undefined || ref === tag ? [] : [refComplaint(manifest.path, ref, tag)]),
  ];
}

function check(version) {
  const wrong = presentManifests().flatMap((manifest) => mismatches(manifest, version.text));
  if (wrong.length > 0) throw new ReleaseError(wrong.join('\n'));
  return `epic-pulse: every manifest says ${version.text} and the marketplace installs ${tagOf(version.text)}: ${presentManifests().map((m) => m.path).join(', ')}`;
}

function release(args) {
  const [first, second, ...rest] = args;
  const checking = first === '--check';
  const version = parseVersion(checking ? second : first);
  if (!version || rest.length > 0 || (!checking && second !== undefined)) return { code: 2, error: 'usage: node scripts/release.mjs [--check] <major.minor.patch>' };
  if (checking) return { code: 0, out: check(version) };
  const planned = plan(version);
  try {
    return { code: 0, out: nextSteps(version, cut(planned)) };
  } catch (error) {
    const recover = `git checkout -- . && git switch ${BASE_BRANCH} && git branch -D ${planned.branch}`;
    throw new ReleaseError(`${error instanceof Error ? error.message : 'the release failed'}\nnothing was pushed; to start over: ${recover}`);
  }
}

try {
  const { code, out, error } = release(process.argv.slice(2));
  if (out) console.log(out);
  if (error) console.error(error);
  process.exitCode = code;
} catch (error) {
  console.error(`epic-pulse: ${error instanceof ReleaseError ? error.message : String(error)}`);
  process.exitCode = 1;
}
