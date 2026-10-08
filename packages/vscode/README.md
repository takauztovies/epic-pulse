# Epic Pulse

See how far the GitHub epics behind your Claude Code sessions have got, without leaving the editor.

Epic Pulse puts the epic your sessions are working on in the status bar, as `#1 20% · 1/5`, and lists
every epic in an **Epics** view in the activity bar: its progress, its sub-issues grouped by status
(Todo, In progress, In review, Done, Dropped), and which live sessions are on each. A row reads
`#1 ██░░░░░░░░ 20% Epic title`: the epic's number, a bar and percentage that count closed work only,
then the title. Its description adds `1/5`, the first eight characters of each live session id
(`Session: 0f8e7c1a`, or `No live session`) and `stale` when the data is old.

## Using the view

- **Overview** (above the tree) shows a card per epic: a coloured progress bar with the percentage, and
  all five statuses with their counts, zeros included. The tree lists all five groups under every
  epic too.
- **Click a row** that a live Claude Code session is on to open that session (a list when several
  are). A row with no live session opens the issue on GitHub. A session started in another folder or
  worktree may open as a new conversation here.
- **Right-click** an epic or issue for **Open on GitHub**, and an epic for **Start Working on This
  Epic…**, which opens a new Claude Code tab running `/epic-pulse:intake` on it (needs the plugin).
- **+** in the view title (**Epic Pulse: Track an Epic or Issue…**) tracks an epic or issue by number,
  `owner/repo#N` or URL. It is a repository pin, saved until you click the **Stop Tracking** icon on
  its row.
- **Green**: an issue icon is green while a live session is on it; an epic's icon and the status bar
  are green once it is 100% done.
- **Hover** an epic or issue for its **session time** (how long Claude Code sessions actively worked on
  it, idle gaps over ten minutes not counted) and when a session was last on it.
- The groups In progress, In review and Done start expanded; Todo and Dropped start collapsed.

The full walkthrough is in the [manual](https://github.com/takauztovies/epic-pulse/blob/main/docs/MANUAL.md).

Progress is done / (total − dropped): an issue closed as *not planned* or as a *duplicate* leaves the
count. An epic that tracks its work in a task list instead of sub-issues counts its checked boxes.
Statuses come from GitHub itself: a closed issue is done, or dropped when it was closed as not
planned or a duplicate; an open pull request that will close it puts it in review, or in progress
while the pull request is a draft; an assignee puts it in progress; anything else is todo.

## How sessions bind to issues

Epic Pulse shows what the [epic-pulse Claude Code plugin](https://github.com/takauztovies/epic-pulse)
records. The plugin's hook notes, for each session, the issues it works on:

- a `gh issue` command that changes an issue (`gh issue view`, `list` and `search` never bind);
- closing keywords such as `Fixes #4` in a `git commit` message or a `gh pr create` body;
- edits in a worktree whose branch name carries the issue number;
- `epic-pulse track <N>`, which pins an issue or an epic.

That registry lives inside the repository's git directory, so every worktree of a repository shares
it and it never shows up in `git status`. Without the plugin the view says **Hook inactive**.

## Every state says what it is

| In the tree and the status bar | Meaning |
| --- | --- |
| `#1 20% · 1/5` | Fresh data for the epics of your live sessions, and for pinned ones. |
| Stale | Data over ten minutes old, or from before a failed refresh. It stays on screen. |
| No epic | No live session is on an issue that belongs to an epic, and nothing is pinned. |
| Loading… | Waiting for the first refresh. |
| Refresh failed | GitHub could not be read. A code such as `network` or `rate_limited` says why. |
| Hook inactive | No Claude Code session has reported to this repository in the last week. |
| Unsupported host | A GitHub Enterprise Server without sub-issues. |
| Sign in to GitHub | No working token was found. Click it to sign in. |

**Epic Pulse: Show status details** prints, for each repository, where its registry is, whether the
hook has written there, how the last refresh went and where its token came from. It also lists each
entry of `EPIC_PULSE_HOSTS` that is not a host and is therefore ignored, with the reason.

## Signing in

Epic Pulse uses VS Code's GitHub sign-in, and the GitHub Enterprise one when `github-enterprise.uri`
is set. It asks for the `repo` scope because GitHub has no read-only scope that reaches private
repositories. Epic Pulse only ever sends GraphQL queries; it never changes anything on GitHub.

VS Code signs in to one GitHub Enterprise server only, the one `github-enterprise.uri` names. For a
repository on any other host, **Sign in to GitHub** says so and opens that setting instead of
signing you in to github.com, which would leave the repository signed out.

You do not have to sign in. Without a VS Code sign-in it uses `GH_TOKEN` or `GITHUB_TOKEN`, then
`gh auth token`, exactly like the epic-pulse CLI. An Enterprise host takes `GH_ENTERPRISE_TOKEN` only
when `GH_HOST` or `EPIC_PULSE_HOSTS` names it, and otherwise only your `gh auth login` for that host.
Only when none of these yields a token GitHub accepts does the view offer **Sign in to GitHub**.

## Privacy

- **Network.** Only the GitHub GraphQL API of the host your issues live on: `api.github.com`, or
  your Enterprise server. No telemetry and no other service.
- **Your token** is held in memory for one refresh. It is never written to disk, logged or put in an
  error. A token from VS Code goes only to the host it belongs to: the GitHub sign-in's to
  github.com, the GitHub Enterprise one's to the server `github-enterprise.uri` names. Any other host
  the repository names gets a token the way the CLI finds one, never one from VS Code.
- **Stored in the repository**, in `epic-pulse/` inside its git directory (created owner-only on
  macOS and Linux):
  - `sessions/*.jsonl`, written by the plugin's hook: issue references and timestamps for each
    session. No command text, file paths or file contents. Files untouched for a week are deleted.
  - `pins.json`: issues pinned with `epic-pulse track`.
  - `snapshot.json`: what was fetched from GitHub (epic and sub-issue titles, numbers, URLs and
    statuses), when, the hour's rate-limit counters, and the code of the last failure.
  - `refresh.lock`, while a refresh runs.
- **Stored for your user**, in the epic-pulse cache directory (`~/Library/Caches/epic-pulse` on macOS,
  `$XDG_CACHE_HOME/epic-pulse` or `~/.cache/epic-pulse` on Linux, `%LOCALAPPDATA%\epic-pulse` on
  Windows): `usage.jsonl`, the GitHub points each request cost, with its time, its host and a hash of
  the repository, so that everything refreshing on your machine shares one budget of 300 points an
  hour; and `usage.lock` while it is written.
- **Nothing else.** The extension never creates a registry: a repository the plugin has not written
  to is only read. VS Code keeps a log of the **Epic Pulse** output channel, which holds refresh
  outcomes, codes and local paths, never a token or an issue title.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `epicPulse.refreshSeconds` | `60` | How often to refresh while the window has focus, and to read what is on disk again while it has not, from 30 to 86400. |
| `epicPulse.statusBar.enabled` | `true` | Show the current epic in the status bar. |

A window refreshes once when it opens, then only while it has focus, and whenever you come back to
it, click Refresh, sign in or change its folders. Without focus it asks GitHub for nothing, but on the
same interval it reads the files again and redraws, so the status bar and the Epics view keep their
ages and the stale marker right and show what a hook or another refresher has written. In a
multi-root workspace every folder's repository is in the one view. Every window, the plugin and the
CLI share one lock per repository and one hourly budget, so more windows do not mean more requests to
GitHub.

## Requirements

- VS Code 1.90 or newer, on a trusted folder on disk: Restricted Mode and virtual workspaces are not
  supported.
- A git repository whose issues are on GitHub.
- The epic-pulse Claude Code plugin, for sessions to bind on their own.

## Licence

MIT. Source, issues and the plugin: <https://github.com/takauztovies/epic-pulse>.
