# Changelog

## 0.1.0 (unreleased)

- The **Epics** view: each epic with its progress, its sub-issues grouped by status, and the number
  of live Claude Code sessions on each issue. A click opens the epic or the issue on GitHub.
- A status-bar item with the current epic, and an explicit item for every other state: stale, no
  epic, loading, refresh failed (with its code), hook inactive, unsupported host and signed out.
- Commands: Refresh, Sign in to GitHub, Show status details.
- Sign-in through VS Code's GitHub and GitHub Enterprise accounts, falling back to `GH_TOKEN` and
  `gh auth token` like the epic-pulse CLI. Each sign-in's token goes only to the host it belongs to,
  and for a repository on a host no sign-in serves, Sign in to GitHub opens `github-enterprise.uri`
  instead of signing in to github.com.
- An icon, and `THIRD_PARTY_NOTICES.md` beside the bundle for the zod code inside it.
- Multi-root workspaces: every folder's repository in one view.
