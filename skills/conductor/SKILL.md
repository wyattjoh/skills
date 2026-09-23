---
name: conductor
description: Navigates Conductor worktree environments for parallel agent development. Triggers on working in a .conductor/ directory, mentions of "Conductor", or parallel agent workspaces. PROACTIVE.
effort: low
---

# Conductor Worktree Environment

Conductor gives each parallel agent an isolated git worktree: a complete
checkout on its own branch. The directory above it is the main repository on a
different branch (usually `main` or `canary`), not your workspace.

## Detection

You are in a Conductor worktree when the working directory contains
`.conductor/` (e.g. `/path/to/repo/.conductor/workspace-name`), or when `.git`
is a file containing `gitdir: .../worktrees/...` rather than a directory.

## Working in the worktree

Treat the worktree as the repository root and run commands from it directly
(`pnpm build`, `git status`, `cargo build`). Do not change into the parent
directory or target it (`cd /path/to/repo && ...`, `git -C /path/to/repo ...`),
because those commands act on the main repository's branch instead of yours.

If the shell resets your directory after a command, you likely changed into the
wrong place; stay in the worktree.
