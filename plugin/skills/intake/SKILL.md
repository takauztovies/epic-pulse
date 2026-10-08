---
name: intake
description: Take on a GitHub epic that nobody is working on yet - read it in the context of its program and architecture, show where it stands and propose a plan before any code is touched. Use when the user runs /epic-pulse:intake or asks to start working on an epic.
argument-hint: <epic number | owner/repo#N | issue URL>
allowed-tools: Bash(epic-pulse track:*), Bash(epic-pulse refresh:*), Bash(epic-pulse json:*), Bash(gh issue view:*), Bash(gh issue list:*)
---

# Intake an epic

You are starting work on an epic. Understand it first, and understand it as one part of a larger whole: an epic is never a standalone feature. Do not edit files, create branches or open pull requests until the user has chosen what to start with.

1. If no epic was given, ask the user which one instead of guessing.
2. Pin it to this session, so the epic-pulse status line and VS Code view show this session as the one working on it. Run it as `epic-pulse`, not through `npx`, `node` or a path:

   ```sh
   epic-pulse track $ARGUMENTS
   ```

3. Read the epic itself, read-only: `gh issue view $ARGUMENTS --json title,body,state,labels,assignees,comments`.
4. Read its sub-issues and where each stands: run `epic-pulse refresh`, then `epic-pulse json`, and find the epic in the output by its number. Each child has a status (todo, in_progress, in_review, done, dropped) and `sessionIds`, the live sessions already on it. If the epic is not in the output yet, say so and work from the epic's own text.
5. Place the epic in its program. Do this before you plan anything:
   - Climb to the top. Find the parent issue, the program or main epic, from the epic's body and comments ("Part of", "Parent", "Tracked by", task lists) and `gh issue view` on each link, and keep climbing until there is no parent.
   - Find what else touches it. Run `gh issue list --state all --search "<number> in:body"` for issues that reference it, and read the program's other epics: their goals, their status, the decisions already made in them.
   - Read the repository's own architecture: CLAUDE.md or AGENTS.md, README, and any `docs/`, ADR, spec or design files the epic or the program links to or that cover its area. Search the code for the area the epic will change, and for what already exists there that it must reuse, extend or stay consistent with.
   - Write down a short context map: the program's goal, where this epic sits in it, the sibling epics and their state, the shared components, contracts, data models and decisions it must stay consistent with, and what it must not decide alone.
6. Report briefly:
   - the goal, in one or two sentences, and what "done" means for this epic;
   - how it fits the program, and what it changes for its siblings and for the architecture;
   - the children grouped by status, marking any that already have a live session;
   - dependencies, blockers, decisions that belong at program level rather than in this epic, and anything unclear or contradictory.
7. Propose the first one to three slices in dependency order, each with a one-line acceptance criterion. Never propose a slice as a detached feature: for each, say what in the wider architecture it uses, extends or changes, and which other epics it affects. Recommend where to start.
8. Stop and ask the user which slice to take. Start only after they answer.

Never close, edit, label or comment on an issue as part of intake.
