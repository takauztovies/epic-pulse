# Changelog

Every notable change to epic-pulse is listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Changed

- Statuses follow pull requests more closely. An open pull request from a branch named for the issue
  (`123-login`) counts as its work even when it never mentions the issue: in review when ready, in
  progress as a draft. An open pull request that mentions an issue without closing it moves it to in
  progress (never to review); one that names more than three issues moves none. The query reads the
  repository's 100 most recently updated open pull requests, at no extra cost (measured).

### Added

- **The whole tree.** A sub-issue that has sub-issues is followed as a sub-epic, at every level down to
  GitHub's limit of eight: the VS Code view opens each one onto its own status groups with its own
  percentage, and an epic counts the items at the bottom of its tree rather than its direct children.
  Sub-epics refresh every six minutes (the top epic every two) to keep a deep tree inside the hourly
  budget, and a refresh fetches a whole new tree at once rather than a level per refresh. Each epic now
  costs 5 points (the query asks each child for its sub-issue count). `epic-pulse json` children gain
  `subCount`, `counts`, `percent` and their own `children`.

## 0.3.5

### Fixed

- Clicking an epic or an issue with a live Claude Code session did nothing: the click handed VS Code
  the session ids as separate arguments, so the handler received a bare id instead of the list and
  refused it. It now opens the session.

### Added

- **Jira Cloud (experimental)**, per repository: it has not been run against a real Jira site yet, only against fixtures written from Atlassian's documentation, and this release says so on purpose (fixtures/jira/unverified-ack.json; the release check refuses a later version unless the fixtures are recorded or it is acknowledged again). Declare a `jira` block (`site`, `projects`, optional `statusMap`) in
  `.epic-pulse.json` and set `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in your environment. Epics
  are Jira Epics with their children; statuses follow Jira's status categories with the repository's
  map on top; sessions bind to `PROJ-12` through a branch name, a commit message or
  `epic-pulse track PROJ-12`, only for the declared projects. Credentials go only to a site you list in
  `JIRA_SITE`, never to one a repository names. `epic-pulse json` gains `key` (`#12` or `PROJ-12`) on
  epics and issues. See "Jira" in the README.

## 0.3.4

### Added

- The hover on an epic is now a briefing: the first lines of its description, its open pull requests,
  who its issues are assigned to, how old it is and how many issues were finished in the last 7 days;
  an issue's hover shows its assignees and open pull requests. The same lines are in the status bar
  tooltip (escaped as text) and the Overview card. The query reads three more fields and costs the
  same (4 points per epic); `epic-pulse json` gains `summary`, `createdAt`, `doneLast7Days`,
  `openPullRequests` and `assignees` on epics and `assignees` and `openPullRequests` on issues. The
  snapshot stores them as optional fields, so existing snapshots keep working until their next refresh.

- **Session time** per epic and per issue: how long Claude Code sessions actively worked on it, with
  gaps over ten minutes counted as idle, shown in the hover of the tree, the status bar and the
  Overview card. The hover also says when a session was last on it, and which. Totals are kept in
  `time.json` in the repository's git directory so they outlive the session files. `epic-pulse json`
  gains `activeSeconds`, `lastActivityAt` and `lastSessionId` on epics and issues.

## 0.3.3

### Added

- An **Overview** panel in the VS Code sidebar: a card per epic with a coloured progress bar (blue,
  green at 100%) and every status with its count, zeros included. A click does what a click on the
  tree row does.

### Changed

- The Epics view lists all five status groups under every epic, with their count, even when a group is
  empty.

### Added

- Clicking a row in the VS Code view that a live Claude Code session is on opens that session, through
  the Claude Code extension's `vscode://anthropic.claude-code/open` handler; a quick pick when several
  are on it. A row with none still opens GitHub, and **Open on GitHub** moves to the row's context menu.
- `/epic-pulse:intake <epic>`, and **Start Working on This Epic…** on an epic row in VS Code (a new
  Claude Code tab running the skill). It pins the epic, reads it and its sub-issues, places it in its
  program (parent epic, siblings, architecture notes, the code it touches), proposes slices that each
  say what in the wider architecture they use or change, and waits for a choice before editing anything.
- `docs/MANUAL.md`, a walkthrough of the VS Code view, tracking, the sessions and intake.

## 0.3.1

0.3.0 was tagged but never published (its npm step failed, below), so 0.3.1 is the first release of
everything in it.

### Added

- **Epic Pulse: Track an Epic or Issue…** and **Stop Tracking** in VS Code, on top of the repository
  pins (`pins.json`) the CLI already wrote: a tracked epic shows without a live session and persists
  until untracked.
- `JsonEpic` and `JsonChild` carry `sessionIds`, the live sessions bound to them, beside
  `sessionCount`. The tree row and tooltips and the status bar tooltip name them (`Session: 0f8e7c1a`).
- An issue's icon is green while a live session is on it; an epic's icon and the status bar turn green
  at 100% done, with fresh data.

### Changed

- The progress bar in the status line and the VS Code view counts closed work only, so it can no longer
  fill ahead of the percentage printed beside it. `weightedPercent` stays in `epic-pulse json`.
- The Done group starts expanded, and an epic row always carries its number.

### Fixed

- The release workflow's npm step passed `release/epic-pulse-X.tgz` to `npm publish`, which npm reads
  as a GitHub shorthand; it now passes `./release/...`. The step had never run before.

## 0.2.0

### Added

- `.epic-pulse.json` takes a `progress` block: how much In progress and In review work counts for
  (whole percentages), which labels are sizes and what each is worth, and what an unlabelled item is
  worth. The status line, `epic-pulse json` and the VS Code view all read it from the folder you work
  in. The cache now keeps each item's labels (at most 20) instead of one precomputed size, so a change
  to the file applies at once, without a refetch.
- Size labels weigh the progress: `size/XS`, `S`, `M`, `L` and `XL` are worth 1, 2, 3, 5 and 8, so
  finishing a large item moves the percentage and the bar more than a small one. An unlabelled item
  among sized ones counts as medium, and an epic with no size labels reads exactly as before. The
  `done/total` count stays a count of items. Reading the labels raises the cost of an epic refresh
  from 3 to 4 points of the hourly budget.
- The progress bar credits work in flight: In progress counts a quarter and In review three quarters
  of an item, so a bar ahead of the percentage means work is moving, and it is full only when every
  item is Done. The percentage and the `done/total` count are unchanged. JSON v1 gains
  `weightedPercent` beside `percent`. The bar in the status line and the VS Code view use it.

## 0.1.2

### Added

- The VS Code epics view shows each epic's progress as a text bar and a percentage in front of its
  title (`██░░░░░░░░ 20% Epic title`), so a long title no longer pushes the progress out of view.

## 0.1.1

### Fixed

- The remote is found again on a repository whose `.git/config` has grown past 64KB from
  carrying many worktrees over its life (seen: 867 branches, 95KB): `config` now reads with
  its own, far roomier cap, instead of the one meant for tiny identity files (`HEAD`,
  `commondir`, the gitdir pointer), which silently made `doctor` and the status line report
  "no GitHub remote" on an otherwise healthy repository.

## 0.1.0

The first release.

### Added

- A Claude Code plugin, listed by this repository's own marketplace, which installs it from the release
  tag and never from `main`. Its hooks record, offline,
  which issues a session works on: mutating `gh issue` commands, closing keywords in `gh pr create`
  bodies and commit messages, edits in a worktree whose branch name carries an issue number, and
  `epic-pulse track` pins. The performance promise is that the hook after each tool call runs in the
  background and never blocks it, and that its startup cost is measured, in the README, rather than
  promised as a number. `/epic-pulse:track` pins an issue or epic to the session.
- The `epic-pulse` command on npm, with no runtime dependencies: `statusline`,
  `statusline install [--dry-run] [--project]`, `json`, `track`, `untrack`, `refresh`, `doctor`, and
  `hook`, which the plugin runs.
- A status line that shows the session's epic as a percentage, a bar and the sub-issues in review and
  in progress, renders from disk, and names every state it can be in; `· 2 loading` counts bindings
  still waiting for an answer (`pending` in the `json` output). `statusline install --project`
  writes one command that sh, cmd and PowerShell all run, and that finds the runtime through
  `CLAUDE_CONFIG_DIR`.
- Statuses derived from GitHub: todo, in progress, in review, done and dropped. Progress is
  done / (total − dropped). A closed sub-issue is done unless it was closed as not planned or as a
  duplicate, so one closed with no reason at all counts as done. Epics made of a task list count their
  boxes.
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
