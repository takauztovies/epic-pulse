import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.js';

// The jobs of .github/workflows/ci.yml, read as text: nothing here can run
// Actions, but a guard that decides who may see a token must not be one edit
// from gone without a test noticing.

const CI = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

// The lines of one job: from its key to the next key at the same indent.
function job(name: string): string {
  const lines = CI.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `ci.yml has no job named ${name}`);
  const length = lines.slice(start + 1).findIndex((line) => /^\S|^ {2}\S/.test(line));
  return lines.slice(start, length === -1 ? undefined : start + 1 + length).join('\n');
}

// The live tests run the real refresher against this repository's public demo
// issues. GITHUB_TOKEN is epic-pulse's fallback when GH_TOKEN is not set. A pull
// request from a fork does not run it: its code is not trusted with a token.
test('the live tests run in their own ubuntu job, with the repository token, on this repository\'s own pushes and pull requests only', () => {
  const live = job('live');
  assert.match(live, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(live, /^ {4}if: github\.event_name == 'push' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/m);
  assert.match(live, /^ {10}GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m);
  assert.match(live, /^ {8}run: pnpm test:live$/m);
  assert.match(live, /^ {6}issues: read$/m);
  assert.deepEqual(CI.match(/pnpm test:live/g)?.length, 1, 'only the live job runs the live tests');
  assert.equal(job('test').includes('GITHUB_TOKEN'), false, 'the matrix of test jobs gets no token');
});
