# Changelog

Every notable change to epic-pulse is listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 (unreleased)

The first release.

### Added

- A Claude Code plugin, listed by this repository's own marketplace, which installs it from the release
  tag and never from `main`. Its hooks record, offline,
  which issues a session works on: mutating `gh issue` commands, closing keywords in `gh pr create`
  bodies and commit messages, edits in a worktree whose branch name carries an issue number, and
  `epic-pulse track` pins. The hook after each tool call runs asynchronously, so no tool call waits
  for it; the README gives its measured cost rather than a target. `/epic-pulse:track` pins an issue
  or epic to the session.
- The `epic-pulse` command on npm, with no runtime dependencies: `statusline`,
  `statusline install [--dry-run] [--project]`, `json`, `track`, `untrack`, `refresh`, `doctor`, and
  `hook`, which the plugin runs.
- A status line that shows the session's epic as a percentage, a bar and the sub-issues in review and
  in progress, renders from disk, and names every state it can be in; `· 2 loading` counts bindings
  still waiting for an answer (`pending` in the `json` output). `statusline install --project`
  writes one command that sh, cmd and PowerShell all run, and that finds the runtime through
  `CLAUDE_CONFIG_DIR`.
- Statuses derived from GitHub: todo, in progress, in review, done and dropped. Progress is
  done / (total − dropped). Epics made of a task list count their boxes.
- A pin on an issue that is itself an epic (sub-issues or a task list) shows that issue's own
  progress, not its parent's, whether it was pinned to a session or to the repository.
- One shared refresher per repository with a 300-points-an-hour budget across every repository on the
  machine, and backing off when GitHub rate-limits. `epic-pulse refresh` held back only by that
  pacing says when it can run and exits 0, instead of reporting a budget failure.
- A VS Code extension, Epic Pulse, on the Visual Studio Marketplace and Open VSX, with its own icon.
  Each VS Code sign-in's token goes only to the host it belongs to.
- `.epic-pulse.json` with `branchIssuePattern`, `ignorePaths` and `ignoreMainCheckout`.
- GitHub Enterprise Server and GitHub Enterprise Cloud (data residency) hosts. `doctor` and the VS Code
  status details name any `EPIC_PULSE_HOSTS` entry that is not a host, and why, instead of dropping it
  in silence; the status line stays quiet. A token goes only to
  a host you trust: `GH_TOKEN` and `GITHUB_TOKEN` to github.com alone, `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` only to the host `GH_HOST` names or one listed in `EPIC_PULSE_HOSTS`,
  and any other host gets only the login you made for it with `gh auth login --hostname`. Not yet
  tested against a live Enterprise server.
- Tests that hold the shipped code to its privacy promises: an offline hook, read-only GraphQL, an
  allowlist of every address in the bundle, the documented list of written files, and no token on disk.
- `THIRD_PARTY_NOTICES.md` beside every bundle, in the npm package, the plugin and the extension, with
  the licence text of each package the bundle contains (zod).
- CI on macOS, Linux and Windows with Node 22 and 24, a release workflow with provenance, and a live
  check against the public demo issues, weekly and on every push and pull request from a branch of this
  repository.
