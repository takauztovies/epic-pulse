import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { errnoOf } from './atomic.js';

// "Nothing there" and "a file where a directory should be": both mean the path
// does not exist (yet), which is not an error here.
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

// The one spelling of a path that every caller agrees on. A repository is told
// from another by a string, and one directory has several: os.tmpdir() says
// C:\Users\RUNNER~1\... on a Windows runner where git writes
// C:\Users\runneradmin\..., and /var/folders/... on macOS where git writes
// /private/var/folders/...; a folder reached through a link is the same case.
// Two spellings were two registries.
//
// fsPromises.realpath has the semantics of fs.realpath.native, which asks the
// OS: it follows links and expands 8.3 short names, where the JS realpath only
// walks the string and finds neither. A path that does not exist yet (a file
// about to be written, a registry not created) is its nearest existing
// ancestor's real spelling with the missing tail put back. One that can not be
// resolved at all (no permission, a link loop) keeps its lexical spelling:
// this runs in the hook, which must never fail on a path.
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(await realpath(existing), ...missing);
    } catch (error) {
      const parent = dirname(existing);
      if (parent === existing || !ABSENT.has(errnoOf(error) ?? '')) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}
