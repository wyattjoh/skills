---
name: beam-me-up
description: Moves a Claude Code session, by session ID, to another machine over SSH, recreating its worktree and transcript so it resumes there. Use only when the user explicitly invokes /beam-me-up.
argument-hint: "<session-id> <ssh-target> [--herdr]"
compatibility: Requires SSH access from this machine to the target, Git on both machines, and the session's code reachable through a shared Git remote. The optional Herdr step requires Herdr on the target.
disable-model-invocation: true
---

# Beam a session to another machine

`$ARGUMENTS`

## Goal

The session resumes on the target with `claude --resume <session-id>` from a worktree identical to the source's: same branch and commit, same ignored local files, and the full transcript in the place Claude Code looks for it.

Done when:

- The target worktree's `HEAD` matches the source commit and its branch tracks the same remote branch.
- Every ignored, untracked file the session relied on (such as `.scratch/`) is in the target worktree.
- The transcript `<id>.jsonl` has the same checksum on both machines, and its sidecar directory `<id>/` (subagent and tool-result files) is beside it on the target.
- The user has the exact `cd` and `claude --resume` commands for the target, plus any caveats below that apply.

## Locate the session

- Each transcript sits at `~/.claude/projects/<encoded-dir>/<id>.jsonl`. The encoded name is the directory `claude` was launched from, with every non-alphanumeric character replaced by `-`. A `+` or `.` in a worktree name also becomes `-`, so derive the real path from the transcript's `cwd` and `gitBranch` fields, not by decoding the folder name. Later `cwd` values can be subdirectories; the shortest one is the launch directory.
- A worktree's `locked` file in its Git admin directory (`git rev-parse --git-dir`) can name the session's PID. A live PID means the session may still be writing, so ask the user to exit it before copying, or warn that turns added after the copy stay behind.

## Move the code

- Git moves tracked work. The branch is committed and pushed before the target fetches it; uncommitted changes need the user's go-ahead for a WIP commit.
- On the target, reuse an existing clone at the same repository path, or clone there. Create the worktree at the same path relative to the repository root, on the same branch name, tracking the remote branch.
- Copy ignored files that matter with `rsync`. Check `git status --ignored` on the source, and leave dependency and build directories to be rebuilt.

## Move the transcript

When the target's home path and repository path match the source, the encoded directory name is identical. Otherwise, encode the target's launch directory and use that name, because `--resume` looks up sessions by the current directory.

## SSH gotchas

- If SSH is refused on a macOS target, have the user turn on System Settings → General → Sharing → Remote Login. Tailscale SSH serves only from the open-source `tailscaled` build, not the macOS App Store or standalone apps, so Remote Login is the default.
- macOS ships an old `rsync` without `--mkpath`. Create remote directories with `ssh <target> mkdir -p` first.
- Non-interactive SSH shells skip the login profile, so tools installed through version managers (mise shims, `~/.local/bin`) can be missing from `PATH`. Prepend their directories in the remote command.
- Remote `git fetch` can hang on an agent or host-key prompt. Run it with `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` and a `timeout`, so it fails with an error you can read.

## Herdr on the target (`--herdr`)

Call the Skill tool with `herdr`. `herdr --machine` needs a saved profile; without one, run `herdr` over SSH on the target, where it talks to that machine's running server. Create a workspace with `--cwd` set to the new worktree, a label named after the branch, and `--no-focus`. Start `claude --resume` in it only when the user asks.
