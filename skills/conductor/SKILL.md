---
name: conductor
description: Navigates Conductor worktree environments for parallel agent development. Triggers on working in a .conductor/ directory, mentions of "Conductor", or parallel agent workspaces. PROACTIVE.
effort: low
---

# Conductor Worktree Environment

Critical rules for working in Conductor-managed git worktrees.

## Detection

You are in a Conductor worktree if:

- Working directory contains `.conductor/` in the path (e.g., `/path/to/repo/.conductor/workspace-name`)
- Running `cat .git` shows `gitdir: .../worktrees/...` instead of a directory listing

## Critical Rules

1. **The worktree IS the repository root** - never `cd` to parent directories
2. **Run all commands directly** without path prefixes
3. **The parent directory is NOT your workspace** - it's the main repo on a different branch

## Correct Usage

✅ **Always do this:**

```bash
pnpm build
git status
cargo build
```

❌ **Never do this:**

```bash
cd /Users/.../repo && pnpm build
git -C /Users/.../repo status
```

## Warning Signs

If the shell resets your directory after a command, you likely `cd`'d to the wrong place. Stay in the worktree.

## Why This Matters

Conductor creates isolated worktrees for parallel agent development. Each worktree is a complete checkout on its own branch. The parent directory is the main repository on a different branch (usually `main` or `canary`), not your workspace.
