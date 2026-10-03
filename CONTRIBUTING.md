# Contributing to epic-pulse

Thanks for helping. Issues and pull requests are welcome; for anything larger than a fix, open an
issue first so we can agree on the approach.

## Set up

You need Node 22 or newer and pnpm, at the version `packageManager` in `package.json` names
(`corepack enable` picks it up).

```
pnpm install
pnpm lint          # eslint, including the size and `any` rules
pnpm typecheck     # tsc --noEmit
pnpm test          # builds, then runs every offline test
```

`pnpm test` builds `packages/cli/dist` and `plugin/dist` first, because the CLI tests run the built
bundle as a real process, the way Claude Code runs it.

## The rules

[CLAUDE.md](CLAUDE.md) holds the rules every change follows, whoever writes it; they apply to
people and agents alike. In short:

- Files stay under 250 lines and functions under 30, with at most 3 parameters. ESLint enforces it.
- No `any`. TypeScript is `strict`, ESM, Node 22 or newer. Data is immutable.
- Every value that crosses a boundary is parsed with Zod. Fallible functions return a `Result`, and an
  error that is printed or stored carries a code, never a library's message.
- A token lives in memory only. The hook stays offline, always exits 0 and stores refs and timestamps
  only.
- Tests use `node:test` through `tsx`, flat `test()` calls, and no mocks, stubs, fake servers or test
  doubles: real temp directories, real git repositories, and recorded real GitHub responses.
- Every guard needs a test that can fail. Break the guard, watch the test go red for that reason,
  restore the file byte for byte, watch it go green.
- Fixtures and examples come only from this repository's own public demo issues.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`), small and focused. Stage
  explicit paths. Never skip hooks.

## Tests that call GitHub

Fetching is covered only by live tests against this repository's public demo issues. They need a
token (`GH_TOKEN`, or `gh auth login`):

```
pnpm test:live
```

`test:live` sets `EPIC_PULSE_LIVE=1` with POSIX shell syntax; on Windows, set that variable yourself
and run `pnpm test`. The **Live** workflow runs them every week.

The offline tests parse recorded responses in `fixtures/graphql/`. When the queries change, record
them again from the demo issues:

```
pnpm record-fixtures
```

The recorder stores the status, the body and two rate-limit headers, never a request header, and
refuses to write anything shaped like a token. Review the diff before you commit it.

## plugin/dist is release-owned

Claude Code runs the plugin's `plugin/dist/epic-pulse.mjs` as the release tag holds it (the marketplace
installs the plugin from the tag `v<version>`, never from `main`), and a tag is cut from `main`, so only
a release branch may change it, and CI fails any other pull request that does. Once a release has
committed it, every local build rewrites the tracked copy; leave that change out of your commits
(`git restore plugin/dist`).

## Releasing

Maintainers cut a release in four steps:

1. Move the changes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) to a heading for the new
   version, and merge that to `main`.
2. On an up-to-date `main`, run `node scripts/release.mjs <major.minor.patch>`. The version may be the
   one the manifests already say, for the first release of the version in development, until its tag
   exists; an older one, or one already tagged, is refused. It sets every
   manifest to the version (the npm package, the plugin manifest, its marketplace entry and the VS Code
   extension), points the marketplace entry's plugin source at the tag `v<version>`, rebuilds, commits
   the manifests and `plugin/dist` on `release/v<version>`, and prints the commands that follow. It
   pushes and tags nothing.
3. Push that branch and open a pull request into `main`. CI checks that the committed bundle is the one
   its sources build. Merging it ships nothing yet, and until step 4 the marketplace on `main` names a
   tag that does not exist, so a new plugin install fails: do step 4 straight away.
4. Tag the merge commit and push the tag: `git tag -a v<version> -m v<version> && git push origin
   v<version>`. From then on plugin users get that tag's `plugin/dist`. The **Release** workflow checks
   the tag against every manifest, against the tag the marketplace installs the plugin from, and that
   the tag is on `main`, runs the gates, packs the npm package and the extension, and then waits for a
   maintainer to approve the `release` environment. After approval it publishes to npm, the VS Code Marketplace,
   Open VSX and a GitHub Release, with provenance for each artifact.

The workflow needs these, set as secrets of the `release` environment:

| Secret | For | If it is missing |
| --- | --- | --- |
| `NPM_TOKEN` | npm, with publish rights to `epic-pulse` | npm trusted publishing (OIDC) is used instead |
| `VSCE_PAT` | the VS Code Marketplace, publisher `takauztovies` | that step is skipped with a notice |
| `OVSX_PAT` | Open VSX, namespace `takauztovies` | that step is skipped with a notice |

Every publish step leaves an already published version alone, so a failed release can be re-run.
