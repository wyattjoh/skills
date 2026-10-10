---
name: beam-me-up
description: Moves a Claude Code session, by session ID, to another machine over SSH, recreating its worktree and transcript so it resumes there. Use only when the user explicitly invokes /beam-me-up.
argument-hint: "<session-id> <ssh-target> [--include <path>]... [--dry-run] [--allow-live] [--force-transcript] [--force-includes] [--herdr]"
compatibility: Requires Bun and key-based SSH from this machine to the target, and POSIX sh, git, tar, find, wc, mktemp and cat on the target (plus herdr and claude for --herdr). The target user's login shell must accept POSIX single-quoted arguments (sh, bash, zsh).
disable-model-invocation: true
---

# Beam a session to another machine

`$ARGUMENTS`

## Goal

The session resumes on the target from a worktree identical to the source's: same branch and commit, the same staged and unstaged changes, the ignored files the session relied on, and the full transcript where `claude --resume` looks for it.

Done when `beam` exits 0 and its JSON summary reports every item verified, and the user has either the Herdr agent it started or the printed `resume` command.

## Run it

```bash
bun $SKILL_DIR/scripts/beam.ts inspect <session-id>
bun $SKILL_DIR/scripts/beam.ts beam <session-id> <ssh-target> [--include <path>]... [--dry-run] [--herdr]
```

1. **Inspect.** `inspect` reports the session's worktree, branch, dirty state, untracked files, ignored entries with sizes, and whether it is still live. Choose `--include` paths from its `ignored` and `untracked` lists: the session's own working files (like `.scratch`), never dependency or build directories. Confirm the list with the user when it is not obvious.
2. **Dry run.** `--dry-run` shows the planned `code`, `includes` and `session` actions without changing the target.
3. **Beam.** The real run moves the branch history and uncommitted changes as a Git bundle, so nothing needs to be pushed. A target without a clone gets one from `origin`, or a full bundle of every local branch when the repository has no remote. It copies the includes and transcript, then compares tree hashes and file checksums on both machines. Pass `--herdr` when the user wants the session resumed on the target. It opens a matching Herdr workspace there and starts `claude --resume` as a Herdr agent.

The script is idempotent: re-running it after a partial failure skips whatever already matches.

## When it refuses

Each refusal names its fix. These need the user's decision rather than a flag added on your own:

- **Session looks live** (lock PID or Herdr pane): ask the user to exit it and run the beam from a different session. Beaming the session you are running in needs `--allow-live`, and the copy then lacks the final turns, so a later beam reports it as diverged. Liveness is only detected for linked worktrees and Herdr panes.
- **Target transcript has turns the source lacks, or has diverged**: the session was resumed there. `--force-transcript` overwrites those turns, so confirm first. An older copy of the source's transcript on the target is replaced without it.
- **Included files changed on the target** since the last move (edited or created there): copy them back or drop that `--include`. `--force-includes` overwrites them, so confirm first.
- **Target worktree diverged** (other branch, commit, or uncommitted changes): the user resolves it on the target.
- **SSH refused on a Mac target**: the user turns on System Settings → General → Sharing → Remote Login. Tailscale SSH only serves from the open-source `tailscaled` build, not the Mac apps.
- **Tool missing on the target**: put its directory on PATH in the target's non-interactive shell startup (`~/.zshenv` for zsh).

If `--herdr` reports `status: "blocked"`, show the user the returned screen excerpt. Do not answer the prompt for them.
