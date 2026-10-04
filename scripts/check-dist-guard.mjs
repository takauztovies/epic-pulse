// The plugin/dist guard CI runs on every pull request. plugin/dist is what
// every plugin user runs once a release tag holds it, and a tag is cut from
// main, so only a release branch of this repository may change it, and a
// release branch must commit exactly what its sources build.
//
//   BASE_SHA=<base> HEAD_SHA=<head> HEAD_REF=<branch> HEAD_REPO=<owner/repo> \
//   GITHUB_REPOSITORY=<owner/repo> node scripts/check-dist-guard.mjs
//
// Runs in the repository it is started in, after `pnpm build`: on a release
// branch it compares what the build just wrote with what the branch commits.
// Exit 0 passes, 1 fails, 2 means a variable is missing.
import { execFileSync } from 'node:child_process';

const DIST = 'plugin/dist';
const BUNDLE = `${DIST}/epic-pulse.mjs`;
const NAMES = ['BASE_SHA', 'HEAD_SHA', 'HEAD_REF', 'HEAD_REPO', 'GITHUB_REPOSITORY'];

function lines(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
}

function tracked(path) {
  try {
    lines(['ls-files', '--error-unmatch', '--', path]);
    return true;
  } catch {
    return false;
  }
}

function isRelease(ref) {
  return ref.startsWith('release/');
}

// A fork can name its branch release/anything, hence the repository check.
function distChange(pull) {
  const changed = lines(['diff', '--name-only', `${pull.BASE_SHA}...${pull.HEAD_SHA}`, '--', DIST]);
  if (changed.length === 0) return { ok: true, out: ['plugin/dist is unchanged.'] };
  if (isRelease(pull.HEAD_REF) && pull.HEAD_REPO === pull.GITHUB_REPOSITORY) {
    return { ok: true, out: [`plugin/dist changes on ${pull.HEAD_REF}, a release branch of this repository.`] };
  }
  const error = `::error::plugin/dist is release-owned: only a release/* branch of ${pull.GITHUB_REPOSITORY} may change it (node scripts/release.mjs <version>).`;
  return { ok: false, out: [error, ...changed] };
}

// Merging a release branch puts its plugin/dist on main, and the tag cut from
// there ships it. So the build may change no file the branch commits, and must
// write none it leaves out: `git diff` alone misses a built file nobody
// committed, which plugin/dist being ignored would otherwise hide.
function releaseBuild(pull) {
  if (!tracked(BUNDLE)) return { ok: false, out: [`::error::${BUNDLE} is not committed on ${pull.HEAD_REF}.`] };
  const wrong = [...lines(['diff', '--name-only', '--', DIST]), ...lines(['ls-files', '--others', '--', DIST])];
  if (wrong.length === 0) return { ok: true, out: [`plugin/dist on ${pull.HEAD_REF} is exactly what its sources build.`] };
  const error = `::error::plugin/dist on ${pull.HEAD_REF} is not what its sources build: commit the build, as node scripts/release.mjs does.`;
  return { ok: false, out: [error, ...wrong] };
}

function check(env) {
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length > 0) return { code: 2, out: [`usage: set ${missing.join(', ')} and run node scripts/check-dist-guard.mjs`] };
  const checks = [distChange(env), ...(isRelease(env.HEAD_REF) ? [releaseBuild(env)] : [])];
  return { code: checks.every((result) => result.ok) ? 0 : 1, out: checks.flatMap((result) => result.out) };
}

const { code, out } = check(process.env);
console.log(out.join('\n'));
process.exitCode = code;
