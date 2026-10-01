# CLAUDE.md - contributor rules for epic-pulse

epic-pulse shows how far the GitHub epics behind a Claude Code session have got.
This repository is public and MIT licensed. These rules apply to every change,
whether a person or an agent writes it.

## Hard limits (ESLint enforces them, `pnpm lint` must pass)

| Rule | Limit |
| --- | --- |
| File length | under 250 lines, comments and blanks included. Plan the split at 200. |
| Function length | under 30 lines |
| Parameters | at most 3. Use an options object beyond that. |
| `any` | never. Use `unknown` and narrow it. |
| Data | immutable. Return new objects, never edit an argument. Prefer `readonly` types. |
| TypeScript | `strict`, ESM, Node 22 or newer |

ESLint fails at 250 and 30 lines. Treat that as the ceiling, not the target.

## Boundaries and errors

- Every value that crosses a boundary is parsed with Zod: hook and status-line
  payloads, `.epic-pulse.json`, registry lines, `pins.json`, the snapshot, GraphQL
  responses and `settings.json`. Hook payloads are parsed leniently (unknown keys
  pass through) and reduced to the few fields we read. Nothing else is kept.
- Fallible functions return `Result<T, E>` (`packages/core/src/result.ts`) with
  plain-data errors. Errors that are persisted or printed carry a code from
  `ErrorCodeSchema` plus a whitelisted detail, never a library message.
- A token lives in memory only. It is never logged, written to a file, put in an
  error, or offered to a host other than the one it belongs to.
- The hook must stay offline, always exit 0, and store refs and timestamps only:
  no command text, no file paths, no file contents.

## Tests

- Runner: `node:test` through `tsx`. `pnpm test` runs everything offline.
- No mocks, stubs, fake servers or test doubles. Use real temp directories, real
  temp git repositories (`git init`, `git worktree add`) and recorded real
  GraphQL responses fed to the parse layer (`fixtures/graphql/`, written by
  `pnpm record-fixtures`).
- Network fetching is covered only by live tests against the public demo repo,
  gated behind `EPIC_PULSE_LIVE=1` (`pnpm test:live`).
- Time is an argument (`now`), never a fake clock.
- Every guard needs a test that can fail. Break the guard, watch that test go red
  for the intended reason, restore the file byte for byte, watch it go green.
- Flat `test()` calls, not `describe` blocks: a `describe` callback would count
  as one long function.

## Repository hygiene

- Fixtures and examples come only from this repository's own public demo issues.
  Do not add names, paths, issue titles or data from any other project.
- Do not touch `plugin/dist` outside a `release/*` branch.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`), small and focused.
  Stage explicit paths. Never skip hooks.

## Commands

```
pnpm lint          # eslint, includes the size and any rules
pnpm typecheck     # tsc --noEmit
pnpm build         # esbuild: packages/cli/dist and plugin/dist, the same bytes
pnpm test          # builds, then runs the offline tests
pnpm test:live     # also runs the tests that call GitHub (needs a token)
pnpm record-fixtures
```

## Layout

- `packages/core/src` shared logic, one module per responsibility. Private and
  bundled into every artifact.
- `packages/cli` the npm package `epic-pulse`: one bundled file, no runtime
  dependencies. Its tests run the built bundle as a real process.
- `fixtures/graphql` recorded GitHub responses.
- `scripts` tooling: fixture recorder, build and release.
