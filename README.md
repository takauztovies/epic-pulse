# epic-pulse

See, while a Claude Code session works, how far the GitHub epics behind its issues have got: the
percentage done and the sub-issues by status, in the session's status line and in VS Code.

```
#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)
```

That line reads: epic #1 is 20% done, one of its five countable sub-issues is done, one is in review,
two are in progress, and this session is also working on one more epic. epic-pulse works out which
epic a session is on by itself, from what the session does, and reads everything else from GitHub.
It never changes anything on GitHub.

MIT licensed. For macOS, Linux and Windows, with Node 22 or newer (see [Limitations](#limitations) for Windows).

## Install

There are three channels. They share one program and the same data, so use any of them together.

**Claude Code plugin.** This is what records which issues a session works on. In Claude Code:

```
/plugin marketplace add takauztovies/epic-pulse
/plugin install epic-pulse@epic-pulse
```

The plugin's hooks run `node`, so Node 22 or newer must be on the `PATH` Claude Code sees. It also
puts the `epic-pulse` command on the Bash tool's `PATH` inside sessions, and adds the
`/epic-pulse:track` skill. The marketplace installs the plugin from the latest release tag, not from
`main`, so an update reaches you only with a release.

**npm.** The same bundle as a command for every terminal:

```
npm install --global epic-pulse
```

It has no runtime dependencies. Sessions are still recorded by the plugin's hooks; the command is for
setting up the status line, `doctor`, `json` and repository pins.

**VS Code.** Install **Epic Pulse** (`takauztovies.epic-pulse`) from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=takauztovies.epic-pulse)
or [Open VSX](https://open-vsx.org/extension/takauztovies/epic-pulse), or run
`code --install-extension takauztovies.epic-pulse`. It shows the current epic in the status bar and
every epic, by status, in an **Epics** view. Its own README covers its settings and sign-in.

## Set up the status line

A plugin can not set Claude Code's `statusLine`, so one command does it:

```
epic-pulse statusline install             # your user settings, ~/.claude/settings.json
epic-pulse statusline install --project   # ./.claude/settings.json: run it at the repository root
epic-pulse statusline install --dry-run   # show the change and write nothing
```

Inside a session with the plugin enabled, ask Claude to run it; in a terminal, use the npm command or
`npx epic-pulse statusline install`. It copies the program to `~/.claude/epic-pulse/runtime.mjs`, a
path that survives plugin updates, and sets only `statusLine`, to
`node "<that path>" statusline` with a `refreshInterval` of 30 seconds. It saves a timestamped backup
of the settings file first and writes it atomically. Run again, it leaves the settings alone and only
refreshes the runtime copy if that is outdated. If another `statusLine` is already set it changes
nothing and prints the difference instead. A project's settings can not name one person's home
directory, so with `--project` the command is `node -e "<script>" statusline`, whose short script finds
the runtime in `CLAUDE_CONFIG_DIR`, or in `~/.claude` when that is not set. It is one text that sh, cmd
and PowerShell all run. Each teammate still needs the plugin, or `statusline install`, for that copy
to exist.

The status line reads from disk only and never waits on the network. When something is due, it
starts a background refresh, which asks GitHub and writes what it learned for the next render. After
a refresh that failed, it waits a minute before it starts the next one.

## How a session finds its epic

The plugin's hook runs after every Bash, Edit, Write, MultiEdit and NotebookEdit call and notes which
issues the call worked on. It binds an issue when the call:

- runs a `gh issue` command that changes it: `comment`, `close`, `reopen`, `edit`, `develop` or
  `pin`, with the issue as a number, `owner/repo#N` or a URL. `-R`/`--repo` and `GH_REPO` are honoured;
- creates a pull request whose body closes it (`gh pr create --body "Fixes #12"`), or commits with a
  message that does (`git commit -m "... closes #12"`): `close`, `fix` and `resolve` in any form;
- touches a file in a worktree whose branch name starts with the issue number: `123-login`,
  `fix/123-login`, `feat/#77` or `42`, but not `release/1.2.3`. That is the file of an Edit or a
  Write, or an absolute path in a Bash command;
- runs `epic-pulse track <issue>`, which is what `/epic-pulse:track` does. That pins the issue or
  epic to this session; `epic-pulse untrack <issue>` takes it off again, and keeps edits on its
  branch from binding it back.

`gh issue view`, `list`, `search`, `status` and `create` never bind, and neither do reads. A call that
names more than three issues binds none of them. A binding lapses six hours after the last call that
saw it; a pin lasts until it is untracked or the session ends. A session counts as live for two hours
after its last hook call, unless it has ended; its own status line keeps its issues current after that
too. A session has ended when its end is later than its latest start, so a hook call that ran late,
after the end, does not bring it back, and resuming it, which starts it again, does.

`epic-pulse track <issue> --repo`, or `epic-pulse track <issue>` run in a terminal rather than in a
session, pins the issue for every session of the repository instead, in `pins.json`.

In a session the hook finds the pin by the command's name, so run it as `epic-pulse track …`, by name
or by the path of the command. Behind a launcher (`npx`, `pnpm exec`, `sudo`, `env`, or `node` and a
script) the hook sees a command with another name and pins nothing. `track` says so when it can tell,
which it can for `npx` and `pnpm exec` (they set `npm_command=exec`), and then writes nothing; it can
not tell for the others. `--repo` needs no hook, so it works behind any launcher.

An issue's epic is its parent issue. An issue without a parent is an epic itself when it has
sub-issues or, failing that, a task list. A pin names its issue, so a pinned issue that is itself an
epic (it has sub-issues, or a task list) shows its own progress even when it has a parent; any other
pinned issue shows its parent's epic, as work on it does. The refresher asks GitHub about it once
(3 points) and again only after the 30-minute cache of its resolution.

## What it costs a session

The hook after a tool call runs asynchronously: Claude Code starts it and carries on, so no tool call
waits for epic-pulse. The hooks at session start and end run once each, and Claude Code waits for
them, within their five-second timeout. The status line renders from disk and, when a refresh is
due, starts one in the background; it never waits on the network.

Each hook call and each status-line render is one short Node process, so most of its cost is Node
starting up. epic-pulse sets no fixed target for it. Measured on an Apple M4 Pro with Node 22, on a
busy machine, in three runs of 20 calls each:

| | Median | p95 |
| --- | --- | --- |
| A hook call | 85–90 ms | 101–123 ms |
| A status-line render | 87–90 ms | 92–104 ms |
| `node -e ''`, for comparison | 46 ms | 47 ms |

`pnpm test` measures both on your machine and prints them (`packages/cli/test/perf.test.ts`). Its
only limit is a 1.5-second tripwire that catches a render waiting on the network.

## Statuses and the percentage

| Status | A sub-issue that is |
| --- | --- |
| Todo | open, with nobody assigned and no pull request on the way |
| In progress | open and assigned, or with a draft pull request that will close it |
| In review | open, with a ready pull request that will close it |
| Done | closed as completed, or closed without a reason |
| Dropped | closed as not planned, or as a duplicate |

A pull request counts when it is open, belongs to the issue's own repository (which may not be the
epic's), and either GitHub links it as closing the issue or its body closes the issue with a keyword.

**% = done / (total − dropped)**, rounded down, so 100% always means finished. Dropped work leaves
the count instead of holding the epic below 100% forever.

An epic that tracks its work as a task list instead of sub-issues counts its boxes: a checked box is
done, an unchecked one is todo, and a box whose whole text is struck through (`~~like this~~`) is
dropped. Task lists inside code blocks and HTML comments are ignored.

Every state of the status line says what it is:

| Status line | Meaning |
| --- | --- |
| `#1 … 20% 1/5` | the session's epic, from fresh data |
| `… · stale` | data over ten minutes old, or a refresh failed (`stale (network)` says why); it stays shown |
| `… · 2 loading` | two more bindings or pins of the session have not been answered yet (`pending` in `epic-pulse json`); the epic it already has stays shown. Not counted once a refresh has failed: the error says that |
| `epic-pulse: loading…` | the first refresh has not finished yet |
| `epic-pulse: no epic` | nothing bound or pinned belongs to an epic |
| `epic-pulse: error (no_token)` | nothing could be fetched; the code says why |
| `epic-pulse: hook inactive` | the hook has recorded nothing for this session |
| `epic-pulse: unsupported host (no sub-issues)` | a GitHub Enterprise Server without sub-issues |

A `+` after the count means the epic has more than 100 sub-issues, or a task list of more than 500
boxes, and only the first 100 sub-issues or 500 boxes are counted.

## Configuration: `.epic-pulse.json`

Optional, at the root of a worktree. It is treated as untrusted data from whatever repository is open:
a field that is wrong falls back to its default without voiding the others.

```json
{
  "branchIssuePattern": "^(?:[\\w.-]+/)?#?(\\d+)(?:[-_]|$)",
  "ignorePaths": ["docs", "vendor/generated"],
  "ignoreMainCheckout": false
}
```

- `branchIssuePattern`: a regular expression with exactly one capture group, the issue number. The
  value above is the default. A pattern that is invalid, longer than 200 characters, has another
  number of capture groups or could backtrack badly is refused, and the default is used.
- `ignorePaths`: up to 100 paths, relative to the worktree, whose edits never bind.
- `ignoreMainCheckout`: `true` binds nothing from edits in the main checkout, only from linked
  worktrees. Useful when the main checkout sits on a long-lived branch.

## Privacy and security

**What leaves your machine.** Only GraphQL queries to the GitHub API of the host the issues live on:
`api.github.com`, `api.<name>.ghe.com` or your GitHub Enterprise Server's `/api/graphql`. Every query
is a read: epic-pulse sends no mutation. There is no telemetry and no other service. The hook never
uses the network at all; only the refresher does.

**Your token.** For github.com it comes from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`,
and a github.com token is never sent to another host. Any other host is named by repository data (a
remote, `gh -R`, an issue URL), which whatever repository you open controls, so it gets a token only
if you trust it:

- a host you name in `GH_HOST`, or list in `EPIC_PULSE_HOSTS` (comma-separated, exact hosts:
  `EPIC_PULSE_HOSTS=ghe.example.com,acme.ghe.com`), takes `GH_ENTERPRISE_TOKEN`, then
  `GITHUB_ENTERPRISE_TOKEN`, then `gh auth token --hostname <host>`. `gh` itself ties the two
  Enterprise variables to no host, which is why epic-pulse asks you to name one;
- any other host takes only `gh auth token --hostname <host>`: a host you logged in to with
  `gh auth login --hostname <host>` is one you trust. `gh` is asked without the four token
  variables, so it answers with that login alone. Without one the host gets no token, and its
  refresh stops with `no_token`.

The token is held in memory for one refresh and never written to disk, logged or put into an error
message; `doctor` shows only where it came from.

**Which scope.** epic-pulse reads issues and pull requests. The token `gh auth login` creates works.
A classic token needs the `repo` scope for private repositories, because GitHub has no read-only
scope that reaches them; public repositories need no scope. The VS Code extension asks VS Code for
`repo` for the same reason, and still only sends queries.

### Files it writes

While you work, epic-pulse writes these files and no others:

```text
<git-common-dir>/epic-pulse/sessions/<session-id>.jsonl
<git-common-dir>/epic-pulse/pins.json
<git-common-dir>/epic-pulse/snapshot.json
<git-common-dir>/epic-pulse/hook.log
<git-common-dir>/epic-pulse/hook.log.1
<git-common-dir>/epic-pulse/refresh.lock
<git-common-dir>/epic-pulse/refresh-attempt.json
<claude-config-dir>/epic-pulse/runtime.mjs
<user-cache-dir>/epic-pulse/usage.jsonl
<user-cache-dir>/epic-pulse/usage.lock
```

| File | Written by | Holds |
| --- | --- | --- |
| `sessions/<session-id>.jsonl` | the hook | one line per call: the event, a timestamp and the issue references bound or unbound. Never a command, a file path or file contents. Deleted after a week untouched. |
| `pins.json` | `epic-pulse track --repo` | the repository's pinned issue references and when they were pinned |
| `snapshot.json` | the refresher | what GitHub returned: epic and sub-issue numbers, titles, URLs and statuses, when they were fetched, this repository's points for the hour, the token's rate-limit counters and the code of the last failure |
| `hook.log`, `hook.log.1` | the hook | an error code and a timestamp per failed call; past 64 KiB it moves to `hook.log.1` |
| `refresh.lock` | the refresher | a process id and a random token, while a refresh runs |
| `refresh-attempt.json` | `epic-pulse refresh`, which the status line starts | when the last refresh ended and the code it stopped with; after a failure the status line starts the next one a minute later |
| `runtime.mjs` | the hook at session start, and `statusline install` | a copy of the program for the status line to run |
| `usage.jsonl` | the refresher | the last hour's charges, one line each: when, which host, how many points and a hash of the repository's registry path, so that every refresher on the machine shares one budget of 300 points an hour |
| `usage.lock` | the refresher | a process id and a random token, while the ledger is written |

- `<git-common-dir>` is the repository's `.git` directory, which all its worktrees share. Nothing is
  written to the working tree, so `git status` stays clean. `EPIC_PULSE_DIR` moves these files.
- `<claude-config-dir>` is `~/.claude`, or `CLAUDE_CONFIG_DIR` when it is set.
- `<user-cache-dir>` is `~/Library/Caches` on macOS, `XDG_CACHE_HOME` or `~/.cache` on Linux and
  `%LOCALAPPDATA%` on Windows. `EPIC_PULSE_CACHE_DIR` replaces `<user-cache-dir>/epic-pulse`.

The session files and the logs are only appended to. Every other file is first written to a
temporary sibling (`<name>.<pid>.<random>.tmp`) and then renamed into place. Directories are created
owner-only and files are written owner-only (`0700`/`0600`) on macOS and Linux. Outside a git
repository nothing goes into a registry; only the session-start copy of `runtime.mjs` is made.

`epic-pulse statusline install`, which you run yourself, also writes the settings file it reports,
changing only `statusLine`, and a backup of it next to it,
`settings.json.epic-pulse-<timestamp>.bak`. Nothing else ever touches your settings.

To report a vulnerability, see [SECURITY.md](https://github.com/takauztovies/epic-pulse/blob/main/SECURITY.md).

## Troubleshooting

`epic-pulse doctor` checks the setup and says what is missing. It changes nothing.

```
epic-pulse doctor
  node:                 v22.22.0
  repository:           /path/to/repo (main checkout)
  remote:               github.com/owner/repo
  token:                from gh-cli
  registry:             /path/to/repo/.git/epic-pulse
  hook:                 active: last ran 2026-01-01T12:00:00.000Z
  hook errors:          none
  statusLine (user):    installed: ~/.claude/settings.json
  statusLine (project): not installed: /path/to/repo/.claude/settings.json
  runtime:              present, the same build as this one: ~/.claude/epic-pulse/runtime.mjs
```

An entry of `EPIC_PULSE_HOSTS` that is not a host (`https://ghe.example.com`, `ghe.example.com/api`, a
name with a space or an underscore in it) is ignored, and `doctor` says so with one line per entry:
`EPIC_PULSE_HOSTS: ignored "https://ghe.example.com": that is a URL; name the host alone, without
https:// or a path`. An entry that looks like a pasted token is not printed. The status line stays quiet
about it.

- **`hook inactive`** means no hook has run for this session. Enable the plugin, start a new session,
  and check that `node` 22 or newer is on Claude Code's `PATH`: a native Claude Code install without
  Node can not run the hooks.
- **`error (no_token)`**: set `GH_TOKEN`, or run `gh auth login`. On a GitHub Enterprise host, run
  `gh auth login --hostname <host>`, or set `GH_ENTERPRISE_TOKEN` and name the host in `GH_HOST` or
  `EPIC_PULSE_HOSTS` (see [Your token](#privacy-and-security)). **`unauthorized`**: GitHub refused
  the token. **`budget`**: the 300 points of the last hour are spent; it resumes by itself.
  **`rate_limited`**: GitHub asked to slow down; epic-pulse waits five minutes.
- **`loading…` that does not end**: run `epic-pulse refresh` in the repository to see what a refresh
  reports, and look at `hook errors` in `doctor`.
- **`error (forbidden)`** or **`error (not_found)`**: the token can not read that repository's
  issues, or it does not exist. GitHub's answer is kept for 30 minutes, so a fix shows within that.
- **`runtime: present, a different build`** after an upgrade: start a new session, or run
  `epic-pulse statusline install` again.
- **`epic-pulse json`** prints everything epic-pulse knows about the repository as versioned JSON,
  for scripts and bug reports.

## Limitations

- The VS Code **Claude panel** may not show the status line. Use the VS Code extension there.
- On Windows the tests run in CI, but the hooks and the status line in a real Claude Code session are
  checked by hand only.
- An epic's first 100 sub-issues, or the first 500 boxes of its task list, are counted; a larger epic
  is marked with `+`, not paged through.
- Statuses come from issues, pull requests and assignees; GitHub Projects fields are not read yet.
- `statusline install` does not chain with a status line you already have; it refuses instead.
- Only the direct parent of an issue is its epic.
- A session that only reads issues (`gh issue view`) is not detected, by design.
- GitHub Enterprise Server versions without sub-issues show `unsupported host`.

## Contributing

See [CONTRIBUTING.md](https://github.com/takauztovies/epic-pulse/blob/main/CONTRIBUTING.md) and
[CHANGELOG.md](https://github.com/takauztovies/epic-pulse/blob/main/CHANGELOG.md). Licensed under the
[MIT License](https://github.com/takauztovies/epic-pulse/blob/main/LICENSE).
