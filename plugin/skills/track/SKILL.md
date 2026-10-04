---
name: track
description: Pin a GitHub issue or epic to this Claude Code session so epic-pulse shows its progress in the status line. Use when the user runs /epic-pulse:track or asks to track an issue or epic.
argument-hint: <issue number | owner/repo#N | issue URL> [--repo]
allowed-tools: Bash(epic-pulse track:*)
---

# Track an issue or epic

Run this command with the Bash tool, exactly as written, with the user's argument in place of `$ARGUMENTS`:

```sh
epic-pulse track $ARGUMENTS
```

- Run it as `epic-pulse`, not through `npx`, `node` or a path. The epic-pulse hook recognises the pin by that command name and pins the issue to this session only; nothing is written to the repository.
- Add `--repo` only when the user asks to pin it for the whole repository. That writes a repository pin that every session sees.
- If no issue was given, ask the user which issue or epic to track instead of guessing.

Tell the user the command's output in one line. The status line shows the epic within about 30 seconds.
