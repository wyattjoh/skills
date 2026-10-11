---
name: beam-me-up
description: Moves a Claude Code session (by session ID) or a bare Git worktree such as a Pando one (by path) to another machine over SSH, recreating the worktree, and the transcript when there is a session, so work resumes there. Use only when the user explicitly invokes /beam-me-up.
argument-hint: "<session-id|path> <ssh-target> [--include <path>]... [--dry-run] [--allow-live] [--force-transcript] [--force-includes] [--herdr]"
compatibility: Requires Bun and key-based SSH from this machine to the target, and POSIX sh, git, tar, find, wc, mktemp and cat on the target (plus herdr for --herdr, and claude when resuming a session). The target user's login shell must accept POSIX single-quoted arguments (sh, bash, zsh).
disable-model-invocation: true
---

# Beam a session or worktree to another machine

`$ARGUMENTS`

## Goal

The target has a worktree identical to the source's: same branch and commit, the same staged and unstaged changes, and the ignored files the work relied on. For a session, its full transcript is also where `claude --resume` looks for it.

The first argument picks what moves. A session ID (UUID) moves that session and the worktree it ran in. Any other argument is a path inside a worktree (a Pando worktree, or any linked worktree or main checkout), which moves alone. Move one worktree per run. When the user names several, run once per worktree.

Done when `beam` exits 0 and its JSON summary reports every item verified. The user then has one of: the Herdr agent or workspace it opened, the printed `resume` command for a session, or the `destination.worktree` path for a bare worktree.

## Run it

```bash
bun $SKILL_DIR/scripts/beam.ts inspect <session-id|path>
bun $SKILL_DIR/scripts/beam.ts beam <session-id|path> <ssh-target> [--include <path>]... [--dry-run] [--herdr]
```

1. **Inspect.** `inspect` reports the worktree, branch, dirty state, untracked files, ignored entries with sizes, and whether a session is still live. Untracked files move only through `--include`. Choose `--include` paths from its `ignored` and `untracked` lists: the work's own files (like `.scratch`), never dependency or build directories. Confirm the list with the user when it is not obvious.
2. **Dry run.** `--dry-run` shows the planned `code`, `includes` and `session` actions without changing the target. `session` is `none` for a bare worktree.
3. **Beam.** The real run moves the branch history and uncommitted changes as a Git bundle, so nothing needs to be pushed. A target without a clone gets one from `origin`, or a full bundle of every local branch when the repository has no remote. It copies the includes and any transcript, then compares tree hashes and file checksums on both machines. Pass `--herdr` when the user wants to continue in Herdr on the target. It opens a matching Herdr workspace there and, for a session, starts `claude --resume` as a Herdr agent.

The script is idempotent: re-running it after a partial failure skips whatever already matches.

## When it refuses

Each refusal names its fix. These need the user's decision rather than a flag added on your own:

- **Session looks live** (lock PID or Herdr pane): ask the user to exit it and run the beam from a different session. Beaming the session you are running in needs `--allow-live`, and the copy then lacks the final turns, so a later beam reports it as diverged. Liveness is only detected for linked worktrees and Herdr panes. A bare worktree is refused the same way when a Claude session holds its lock.
- **Target transcript has turns the source lacks, or has diverged**: the session was resumed there. `--force-transcript` overwrites those turns, so confirm first. An older copy of the source's transcript on the target is replaced without it.
- **Included files changed on the target** since the last move (edited or created there): copy them back or drop that `--include`. `--force-includes` overwrites them, so confirm first.
- **Target worktree diverged** (other branch, commit, or uncommitted changes): the user resolves it on the target.
- **SSH refused on a Mac target**: the user turns on System Settings → General → Sharing → Remote Login. Tailscale SSH only serves from the open-source `tailscaled` build, not the Mac apps.
- **Tool missing on the target**: put its directory on PATH in the target's non-interactive shell startup (`~/.zshenv` for zsh).

If `--herdr` reports `status: "blocked"`, show the user the returned screen excerpt. Do not answer the prompt for them.
