# Epic Pulse manual

How to use Epic Pulse day to day: seeing which epics your Claude Code sessions are on, opening those
sessions, tracking epics by hand, and starting an epic nobody is working on yet. The
[README](../README.md) is the reference for how sessions bind to issues, what is stored and the
configuration file; this is the walkthrough.

## 1. What you get

Epic Pulse shows how far the GitHub epics behind your Claude Code sessions have got, in three places:

| Where | What it shows |
| --- | --- |
| The **Epics** view in VS Code | Every epic, its sub-issues grouped by status, and which live session is on what. |
| The VS Code **status bar** | The first epic, as `#1 20% · 1/5`. |
| The Claude Code **status line** | The session's own epic, as `#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2`. |

The three read the same data. The plugin records which issues each session works on, and a refresh
fetches their epics from GitHub.

## 2. Set up

1. **Plugin** (sessions bind to issues on their own): in Claude Code run
   `/plugin marketplace add takauztovies/epic-pulse`, then `/plugin install epic-pulse@epic-pulse`.
2. **VS Code extension**: install **Epic Pulse** (`takauztovies.epic-pulse`), or run
   `code --install-extension takauztovies.epic-pulse`. It signs in through VS Code's GitHub sign-in,
   or uses `GH_TOKEN` / `gh auth token`; the view offers **Sign in to GitHub** when it finds no token.
3. **Status line** (optional): `npm install --global epic-pulse`, then `epic-pulse statusline install`.

Open a folder that is a git repository whose issues are on GitHub, and open the **Epic Pulse** icon in
the activity bar. If it says **Hook inactive**, no session has reported to this repository yet: check
that the plugin is enabled and that Node 22 or newer is on Claude Code's `PATH`.

## 3. The Overview panel and the Epics view

Above the Epics view sits **Overview**: one card per epic with a coloured progress bar, the percentage
at the right, and every status with its count, zeros included:

```
#1 Demo epic: sample onboarding flow                    20%
▇▇▇▇░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
● Todo 1   ● In progress 2   ● In review 1   ● Done 1   ● Dropped 1
1/5 · 20% · Session: 0f8e7c1a
```

The bar is blue and turns green at 100%; it counts closed work only. Click a card's title for what a
click does in the tree (open the live session, or the issue on GitHub).

### The Epics view

Each epic is a row:

```
#1 ██░░░░░░░░ 20% Demo epic: sample onboarding flow     20% · 1/5 · Session: 0f8e7c1a
```

- **`#1`**: the epic's issue number, always shown.
- **The bar and the percentage** count closed work only: Done over everything that is not Dropped. An
  issue closed as *not planned* or as a *duplicate* leaves the count. A full bar means the epic is
  finished. The bar fills in tenths and rounds down, so 19% shows one cell.
- **`1/5`**: Done over countable issues.
- **`Session: 0f8e7c1a`**: the first eight characters of each live Claude Code session working on any
  of its issues, or **No live session**.
- **`stale`**: the data is over ten minutes old, or from before a failed refresh. It stays on screen.

Under an epic, its issues are grouped by status, in workflow order. All five groups are always there, with their count, so an empty one reads `0`:

| Group | An issue is here when |
| --- | --- |
| Todo | It is open, with no assignee and no open pull request. Starts collapsed. |
| In progress | It is open and assigned, or has a draft pull request. Starts expanded. |
| In review | It is open with a ready pull request that will close it. Starts expanded. |
| Done | It is closed (not as *not planned* or *duplicate*). Starts expanded. |
| Dropped | It was closed as *not planned* or *duplicate*. Starts collapsed. |

A row with items under it is a **sub-epic**: it shows its own `40% · 2/5` and opens onto its own status
groups, however deep the tree goes. The epic's percentage counts the items at the bottom of the tree,
not the sub-epics themselves.

Watching an issue move from Todo to In progress to Done is the point of the view: statuses come from
GitHub itself, so they change when the issue, its assignee or its pull request does.

### Colours

| You see | It means |
| --- | --- |
| A **green issue icon** | A live Claude Code session is on that issue right now, whatever group it is in. |
| A **green epic icon**, and a green status bar | The epic is 100% done and its data is fresh. |
| Everything else | The theme's own colour. |

Hover an epic for a briefing:

```
#1 Demo epic: sample onboarding flow
20% · 1/5: Todo 3 · In progress 1 · Done 1 · Dropped 1
Summary: Public demo epic used by epic-pulse fixtures and live tests. Children cover every derived status.
Open pull requests: 2 · Assigned: @takauztovies
Opened 8 days ago · 1 done in the last 7 days
Session: 0f8e7c1a
Session time: 3 h 20 min
Last active 12 min ago (session 0f8e7c1a)
updated just now
```

- **Summary** is the first lines of the epic's description, without markup or links.
- **Open pull requests** counts those that will close an issue of the epic; **Assigned** lists who
  has its issues (up to five people).
- **Opened … · N done in the last 7 days** answers "is it moving?".

An issue's hover shows who has it and its open pull requests. Both also show: counts per status, the sessions, **session time**, when a session was
last on it, and when it was last refreshed.

### Session time

Hover an epic or an issue to see `Session time: 3 h 20 min` and `Last active 12 min ago (session
0f8e7c1a)`. It is how long Claude Code sessions actively worked on it, not your own hours:

- Between two calls a session makes, the time goes to the issue the session is working on. A gap
  longer than 10 minutes counts as idle and adds nothing.
- A session on two issues at once splits the time between them, so nothing is counted twice, and an
  epic's time is its own plus all its issues'.
- A session stops counting when it unbinds the issue, ends, or its binding lapses after six hours (a
  pin never lapses).
- Totals are saved per issue in `time.json` in the repository's git directory, so they survive after
  the session files are deleted. They hold issue references and numbers only.
- Time counts from the version that introduced it; earlier sessions that are already gone are not
  reconstructed.

## 4. Everyday tasks

### See which session is on what
Look for green issue icons, and for `Session: …` on the epic row. An issue's own row says
`1 session` or `2 sessions`.

### Open the session working on an issue or epic
**Click the row.** If a live session is on it, Claude Code opens that session (or focuses its tab). If
several are, you pick one from a list. A row with no live session opens the issue on GitHub instead.

Claude Code looks a session up in the folder it was started in. A session started in another worktree
or folder may open as a new conversation here instead. Open that folder in its own window to resume it.

### Open an issue on GitHub
**Right-click** an epic or issue and choose **Open on GitHub**. That works whether or not a session is
on it.

### Track an epic by hand
Click **+** in the Epics view title (or run **Epic Pulse: Track an Epic or Issue…**). Enter a number,
`owner/repo#N` or an issue URL; a bare number means the current folder's repository. If the window has
several repositories you pick one first.

The epic then shows in the view whether or not a session is working on it. This is a repository pin
(`pins.json` in the repository's git directory): it persists across sessions and restarts until you
remove it, and every worktree of the repository shares it.

A pin made inside a session with `/epic-pulse:track` is different: it belongs to that session and ends
with it. Add `--repo` (`epic-pulse track 12 --repo`) to make a repository pin from the terminal.

### Stop tracking an epic
Hover the epic's row and click its **Stop Tracking** icon. That removes the repository
pin. An epic that a live session is still working on stays in the view while the session binds it; it
only leaves when nothing binds or pins it any more.

### Start working on an epic nobody is on yet
Right-click an epic and choose **Start Working on This Epic…**. A new Claude Code tab opens with
`/epic-pulse:intake <epic URL>` as its prompt. If the prompt is not sent on its own, press Enter.

The intake skill does not write code. It:

1. pins the epic to the new session, so the view shows the session on it;
2. reads the epic and its sub-issues and where each stands;
3. places the epic in its program: it climbs to the parent or main epic, reads the sibling epics, the
   repository's architecture notes and the code the epic will touch, and writes down a context map;
4. reports the goal, how the epic fits the program, its children by status, and the decisions that
   belong at program level rather than in this epic;
5. proposes the first one to three slices, each saying what in the wider architecture it uses, extends
   or changes and which other epics it affects, and then waits for you to choose.

It needs the epic-pulse plugin (the skill ships in it). You can also run `/epic-pulse:intake 12` in any
session. Intake never closes, edits, labels or comments on an issue.

## 5. The Claude Code status line

`epic-pulse statusline install` adds it to `~/.claude/settings.json` (`--project` for the repository's
own settings, `--dry-run` to see the change first). It shows the session's own epic:

```
#1 ▓▓░░░░░░░░ 20% 1/5 · rev 1 · wip 2 (+1)
```

`rev` is issues in review, `wip` is in progress, and `(+1)` is one more epic. When the line is too
narrow the bar goes first, then the counts. Like the views it counts Done only.

## 6. Command reference

| Command | What it does |
| --- | --- |
| Refresh | Refreshes now (also the view's refresh button). Palette: **Epic Pulse: Refresh**. |
| Track an Epic or Issue… | Pins an epic or issue to the repository. Palette and the view's **+** button. |
| Stop Tracking | Removes the repository pin. Inline icon on an epic row; not in the palette. |
| Open Claude Code Session | Opens the live session on a row. It is what a click does; not in the palette. |
| Open on GitHub | Opens an epic or issue on GitHub. Row context menu. |
| Start Working on This Epic… | New session with the intake skill. Epic row context menu. |
| Sign in to GitHub | Signs in through VS Code. Palette. |
| Show status details | Prints where each registry is and how the last refresh went. Palette. |

## 7. Jira

**Experimental.** Jira support has not yet been run against a real Jira site: it was written and tested against Atlassian's documentation, and its test data is hand-written. Expect rough edges (statuses, paging, an expired token reading as "no epic"), and report what you see. GitHub is unaffected: nothing changes for a repository without a `jira` block.

A repository whose work is in Jira Cloud is set up once, and then looks the same as a GitHub one, with
Jira keys (`PROJ-12`) instead of `#12`.

1. In the repository's `.epic-pulse.json` add:
   ```json
   { "jira": { "site": "acme.atlassian.net", "projects": ["PROJ"] } }
   ```
   A project's In Review style statuses can be mapped with `"statusMap": { "in qa": "in_review" }`.
2. In **your own environment** (where VS Code and Claude Code start) set `JIRA_SITE=acme.atlassian.net`,
   `JIRA_EMAIL=you@example.com` and `JIRA_API_TOKEN=...` (create one at
   <https://id.atlassian.com/manage-profile/security/api-tokens>, with an expiry). They are not read
   from the repository, on purpose: see the README's privacy section.
3. Work as usual. A branch `feature/PROJ-12-login`, a commit message `PROJ-12 add login`, or
   `/epic-pulse:track PROJ-12` binds the issue; **+** in the Epics view takes `PROJ-12` as well.

Epics are Jira Epics; their issues are the epic's children. Statuses come from Jira's status
categories (To Do, In Progress, Done), with "review" statuses in review and Won't Do / Duplicate
resolutions as dropped. There are no pull-request counts for Jira issues.

## 8. Troubleshooting

| You see | Do this |
| --- | --- |
| **Hook inactive** | Enable the plugin; make sure `node` 22 or newer is on Claude Code's `PATH`. |
| **No epic** | No live session is on an issue that has an epic, and nothing is pinned. Track one with **+**. |
| **Sign in to GitHub** | Click it, or set `GH_TOKEN`, or run `gh auth login`. |
| **Refresh failed** (`rate_limited`, `network`…) | Wait and refresh; every window and the CLI share one hourly budget. |
| Clicking a row opens GitHub, not a session | No live session is on it; sessions count as live for two hours after their last hook call. |
| A session opens as a new conversation | It was started in another folder or worktree; open that folder. |
| **Start Working on This Epic…** does nothing useful | The epic-pulse plugin is not installed, so Claude Code does not know `/epic-pulse:intake`. |
| A Jira epic says **No epic**, or **Refresh failed: no_token** | `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are not in the environment VS Code or Claude Code started with (restart them after setting), `JIRA_SITE` does not list the site in `.epic-pulse.json`, or the token has expired (Jira then answers with nothing). |
| A bar looks behind the work in flight | By design: the bar counts closed work only. In-flight credit is `weightedPercent` in `epic-pulse json`. |

`epic-pulse doctor` checks the setup from a terminal.
