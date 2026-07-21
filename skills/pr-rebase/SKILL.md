---
name: pr-rebase
description: Rebases the current branch onto the latest origin base branch, autonomously resolves conflicts by reading both sides' intentions, verifies the result via project checks, then force-pushes with lease. Triggers on "rebase this branch", "rebase onto main", "update PR with latest base", "resolve rebase conflicts", "run /pr-rebase", or mentions "rebase and push", "refresh branch from origin".
allowed-tools: Bash(gh:*), Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-list:*), Bash(git rev-parse:*), Bash(git push:*), Bash(git fetch:*), Bash(git config:*), Bash(git rebase:*), Bash(git stash:*), Bash(git add:*), Bash(git reset:*), Bash(git checkout:*), Bash(bun:*), Bash(npm:*), Bash(pnpm:*), Bash(yarn:*), Bash(cargo:*), Bash(swift:*), Bash(make:*), AskUserQuestion, Read, Edit, Write, Grep, Glob, TodoWrite
argument-hint: "[--base <branch>] [--abort] [--resume]"
disable-model-invocation: true
effort: high
---

# Rebase a PR branch onto its latest base

Bring the current branch up to date with the latest `origin/<base>`. Resolve
conflicts autonomously by reading both sides' change intent, verify the result,
and force-push with lease.

**Arguments provided**: $ARGUMENTS

Recognized arguments:

- `--base <branch>` override base branch detection.
- `--abort` abort any in-progress rebase and exit. No other work is done.
- `--resume` continue a rebase this skill left paused (e.g., after a
  verification failure the user manually fixed).

Use `TodoWrite` to track progress.

## Phase 1: Preflight

1. `gh auth status` -- must be authenticated. Otherwise stop and suggest
   `gh auth login`.
2. `git branch --show-current` -- must return a non-empty name. Refuse to run
   on the repo's default branch (same check as `pr-create`).
3. **Mid-rebase detection.** Check for `.git/rebase-merge/` or
   `.git/rebase-apply/`. If either exists:
   - If `--abort` was passed: run `git rebase --abort` and exit.
   - If `--resume` was passed: skip to Phase 6 (conflict loop).
   - Otherwise: use `AskUserQuestion` to offer: Resume / Abort / Cancel.
4. **Worktree cleanliness.** `git status --porcelain`. If dirty and no rebase
   is in progress, offer via `AskUserQuestion`:
   1. **Stash and continue** -- `git stash push -u -m "pr-rebase autostash"`.
      Restore with `git stash pop` at the very end.
   2. **Commit first** -- stop and let the user commit.
   3. **Cancel**.

## Phase 2: Resolve Base Branch

Same order as `pr-create`:

1. Explicit `--base <branch>` argument.
2. Existing PR's `baseRefName` from `gh pr view --json baseRefName`.
3. Repo default from `gh repo view --json defaultBranchRef`.

Fetch and validate:

```bash
git fetch origin <base>
git rev-parse --verify origin/<base>
```

## Phase 3: Staleness Check

```bash
BEHIND=$(git rev-list --count HEAD..origin/<base>)
AHEAD=$(git rev-list --count origin/<base>..HEAD)
```

If `BEHIND == 0`: print "Branch is already up to date with `origin/<base>`."
and exit. Nothing to do.

If `AHEAD == 0`: print that there are no local commits to rebase and exit.

## Phase 4: Detect Verification Command

Before touching the rebase, figure out _how_ to verify the result. This is
non-negotiable (see the verification gate in Phase 7).

Detection order (first hit wins):

| Signal                                               | Command                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `deno.json` with `check` task                        | `bun run check`                                                     |
| `deno.json` with `test` task                         | `bun run test`                                                      |
| `package.json` with `typecheck` script               | `npm run typecheck` (or pnpm/yarn/bun equivalent based on lockfile) |
| `package.json` with `test` script (and no typecheck) | `npm test`                                                          |
| `tsconfig.json` without package.json scripts         | `npx tsc --noEmit`                                                  |
| `Cargo.toml`                                         | `cargo check`                                                       |
| `Package.swift`                                      | `swift build`                                                       |
| `Makefile` with `check` or `test` target             | `make check` / `make test`                                          |

If nothing is detected: surface this in the plan and use `AskUserQuestion` to
let the user:

1. **Proceed without verification** (explicitly accept the risk).
2. **Specify a command** (user types a shell command to run).
3. **Cancel**.

Prefer typecheck over full test when both are available for speed. Record the
chosen command for use in Phase 7.

## Phase 5: Plan Presentation

```
pr-rebase plan
---
Branch:        <current>
Base:          <base>  (resolved via: <explicit-arg|existing-pr|default>)
Ahead/Behind:  <AHEAD> ahead, <BEHIND> behind
Target:        origin/<base>  @ <sha>
Verification:  <detected command>  (or: "none (user opted out)")
Autostash:     <yes if dirty | no>

Operations (in order):
  1. git rebase origin/<base>
  2. If conflicts: autonomous resolution per file, bail to user if too large
  3. Run verification: <command>
  4. If verified: git push --force-with-lease origin <current>

Conflict policy:
  - Read both sides' intent via file history + broader context.
  - Apply resolution via Edit.
  - Never ship unverified: verification runs BEFORE push.
  - Bail out to manual resolution if:
    - > 10 conflicted files
    - any binary / generated file conflicts
    - ambiguous semantic conflicts we cannot justify
```

Prompt via `AskUserQuestion`:

1. **Proceed**
2. **Change verification command**
3. **Cancel**

## Phase 6: Execute Rebase

```bash
git rebase origin/<base>
```

- **Clean rebase (no conflicts):** skip to Phase 7.
- **Conflict:** git stops mid-rebase, HEAD is on the conflicted commit. Go to
  the conflict loop.

### Conflict loop (autonomous resolution)

See [references/conflict-resolution.md](references/conflict-resolution.md) for
the full procedure. High level per conflicted commit:

1. `git status --porcelain=v1` -- identify `UU`, `AA`, `DU`, `UD`, `AU`, `UA`
   entries.
2. **Bail-out checks** before doing anything:
   - Count of conflicted files > 10: bail.
   - Any conflict on a binary file (no text diff available): bail.
   - Any conflict on a generated file (lockfiles like `deno.lock`,
     `package-lock.json`, `Cargo.lock`, `go.sum`; `dist/`, `build/`, `.next/`
     outputs): bail. These need dedicated regeneration, not merging.
3. **Per-file resolution.** For each conflicted file:
   - `Read` the file to see the conflict markers with surrounding context.
   - Gather intent from both sides (compute the fork point first:
     `FORK=$(git merge-base ORIG_HEAD origin/<base>)`):
     - `git log -p $FORK..ORIG_HEAD -- <file>` shows what the branch did.
     - `git log -p $FORK..origin/<base> -- <file>` shows what base did.
     - Full detail on ranges and why `ORIG_HEAD` is the right anchor during a
       rebase is in `references/conflict-resolution.md`.
   - Read related files: callers of any symbol inside the conflict region
     (via `Grep`), and tests under the same feature area.
   - Synthesize a resolution that honors **both intentions**, not a
     text-level winner-takes-all. The resolution must compile and must not
     lose behavior introduced on either side.
   - Apply via `Edit`.
4. **Post-resolution sanity check:** grep for leftover conflict markers. If
   any `<<<<<<<`, `=======`, or `>>>>>>>` remain, the resolution is
   incomplete; fix before moving on.
5. **Stage the resolved files:**
   ```bash
   git add <resolved-files>
   ```
6. **Do not run `git rebase --continue` yet.** Go to Phase 7.

### Bail-out path

If any bail-out condition triggered:

1. Leave the rebase in its current mid-conflict state.
2. Print the list of conflicted files and recovery commands:

   ```
   pr-rebase stopped: <reason>

   To resolve manually:
     <edit each conflicted file>
     git add <file> ...
     git rebase --continue
     # or: git rebase --abort

   When done, rerun:  /pr-rebase --resume
   ```

3. Exit.

## Phase 7: Verification Gate

This gate runs **before** `git rebase --continue` after conflict resolution,
and **before** `git push` if the rebase was clean.

```bash
<verification command detected in Phase 4>
```

- **Pass:** continue. If mid-rebase, run `git rebase --continue` -- which may
  land on another conflict and loop back to Phase 6. If not mid-rebase,
  advance to Phase 8.
- **Fail:** stop. Do not `git rebase --continue`. Do not push.
  - Show the failing output (trimmed to the first relevant errors).
  - Show recovery commands:

    ```
    Fix the issues, then:
      <re-run verification>
      /pr-rebase --resume

    Or to abandon this rebase entirely:
      git rebase --abort
    ```

  - Exit.

If the user opted out of verification in Phase 4, skip this gate. (The user
explicitly accepted the risk.)

## Phase 8: Resolution Summary

After the rebase is fully complete (no rebase in progress) but **before**
pushing:

```
pr-rebase summary
---
Base: <base> @ <sha>
Replayed: <AHEAD> commits

Conflicts resolved:
  <path-1>
    Branch intent: <one-line description of what this side was doing>
    Base intent:   <one-line description of what base was doing>
    Resolution:    <one-line description of how both intents are preserved>
  <path-2>
    ...

Verification: <command>  PASSED
```

Prompt via `AskUserQuestion`:

1. **Push** -- proceed with `git push --force-with-lease`.
2. **Inspect first** -- exit without pushing; user can inspect, then rerun
   `pr-rebase` or push manually.
3. **Cancel (reset to pre-rebase)** -- run
   `git reset --hard ORIG_HEAD` to undo the rebase. _(Only offered when the
   rebase is complete; ORIG_HEAD still points at the pre-rebase tip.)_

If the rebase was a clean fast-forward with no conflicts, still show the
summary (just with no `Conflicts resolved` section).

## Phase 9: Push

```bash
git push --force-with-lease origin <current>
```

- **`--force-with-lease` only.** Never plain `--force`. If the lease fails,
  stop and tell the user: someone else pushed to the branch. Do not retry.
- If there was an autostash in Phase 1, restore it now:
  ```bash
  git stash pop
  ```
  If the pop conflicts, stop and tell the user; they need to resolve the
  stash conflict manually.

## Phase 10: Report

Print:

- Pre-rebase and post-rebase SHAs of the branch tip.
- Summary: "Rebased `<current>` onto `origin/<base>` (<AHEAD> commits
  replayed, <N> conflicts resolved). Verification: PASSED. Force-pushed with
  lease."
- If a PR exists, print its URL so the user can see the updated diff.

## Error Handling

| Condition                                                                        | Behavior                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No rebase in progress but `--resume` passed                                      | Tell user there is nothing to resume; exit                                                         |
| Conflict on binary or generated file                                             | Bail out to manual resolution (see Phase 6 bail-out path)                                          |
| Verification command not detected and user picked "proceed without verification" | Print a large warning; do not run Phase 7                                                          |
| `git push --force-with-lease` fails                                              | Someone else pushed. Stop, print the error verbatim. Do not retry and do not escalate to `--force` |
| Autostash pop conflicts                                                          | Leave the stash in the stash list; tell the user and exit                                          |
| User runs `pr-rebase` on the default branch                                      | Stop and tell them to use a feature branch                                                         |

## Safety Rails Summary

1. **Verification before push, always.** No verified test/typecheck = no push.
2. **`--force-with-lease` only.** Never `--force`.
3. **Bail-out thresholds.** >10 files or any binary/generated conflict -> hand
   to user.
4. **Summary before push.** User sees what was done and why before anything
   leaves the machine.
5. **Reset escape hatch.** Offer "reset to pre-rebase (ORIG_HEAD)" at the
   summary step.
6. **Autostash is explicit.** Never silently stash dirty work.

## References

- [references/conflict-resolution.md](references/conflict-resolution.md) --
  detailed protocol for autonomous per-file conflict resolution, including
  context-gathering commands, resolution heuristics, and worked examples.
