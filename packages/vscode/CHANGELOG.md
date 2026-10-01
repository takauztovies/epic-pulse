# Changelog

## 0.1.0 (unreleased)

- The **Epics** view: each epic with its progress, its sub-issues grouped by status, and the number
  of live Claude Code sessions on each issue. A click opens the epic or the issue on GitHub.
- A status-bar item with the current epic, and an explicit item for every other state: stale, no
  epic, loading, refresh failed (with its code), hook inactive, unsupported host and signed out.
- Commands: Refresh, Sign in to GitHub, Show status details.
- Sign-in through VS Code's GitHub and GitHub Enterprise accounts, falling back to `GH_TOKEN` and
  `gh auth token` like the epic-pulse CLI.
- Multi-root workspaces: every folder's repository in one view.
