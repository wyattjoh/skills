---
name: land-local
description: Lands the current worktree branch into the local main branch atomically. Captures the source worktree, leaves Claude Code worktree isolation when needed, commits outstanding work, rebases onto local main, resolves conflicts in the worktree, runs the repo's pre-push gates, then takes an exclusive flock and fast-forwards main. Pi stays in place and uses the Git CLI directly. If main advanced meanwhile the fast-forward is refused and the whole cycle restarts, so main is never left conflicted or half merged and many worktrees can land in parallel. Local only, it never fetches, pushes, or opens a PR. Triggers on "/land-local", "land this branch locally", "land it into main", "merge my worktree into local main", "ff-only merge into main", "land without pushing", "integrate this branch locally".
effort: high
---

# Land Local

Merge this worktree's branch into the local `main`, in a repo where several
agents may be landing at the same time.

One invariant governs everything below: **`main` is either fully landed or
completely untouched.** The only write to `main` is a `git merge --ff-only`
taken under an exclusive lock, so `main` can never sit conflicted, mid-merge,
or dirty. Every expensive or failure-prone step (commit, rebase, conflict
resolution, gates) happens in your own worktree, where it blocks nobody.

Local only. This skill never runs `git fetch`, `git push`, `gh`, `pando
remove`, `git worktree remove`, or `git branch -d`. Landing is the last thing
it does.

**Arguments**: $ARGUMENTS

| Argument       | Effect                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `<branch>`     | Land that branch instead of the current one; it overrides the `BRANCH` Phase 0a captured and must be checked out in `$WORKTREE` |
| `--no-gates`   | Skip Phase 3. Only when the caller already verified the tree                                                                    |
| `--attempts N` | Bound on rebase/land cycles, default 3                                                                                          |

Track the phases with `TodoWrite`; a land that loops twice is easy to lose
your place in.

## The cycle

```
Phase 0a capture source worktree     once, first
Phase 0  preflight                 once
Phase 1  commit the worktree       once
  Phase 2  rebase onto main   |
  Phase 3  gates              | repeat until landed or attempts exhausted
  Phase 4  locked ff-only land|
Phase 5  report
```

Phase 4 returning `REBASE_REQUIRED` is the normal outcome under contention,
not an error. It means another lander won the race; go back to Phase 2.

## Phase 0a: Capture the source worktree

**Do this before anything else.** Capture what you are landing with the Git
CLI before any harness changes the current directory:

```bash
git rev-parse --show-toplevel   # -> WORKTREE
git rev-parse --abbrev-ref HEAD # -> BRANCH
```

Then follow the current harness:

- **Claude Code:** if this session entered the source worktree with
  `EnterWorktree`, call `ExitWorktree` with `action: "keep"`. Never
  `"remove"`; this skill does not delete the user's worktree or branch. If no
  native worktree session is active, do not require the tool, continue from
  the current directory. If a pinned Claude Code session cannot exit, complete
  Phases 0 through 3, then stop at Phase 4 and give the user its filled-in
  locked block to run with `!`.
- **Pi:** do not call `ExitWorktree` and do not use Pando. Stay in the current
  directory and use the Git CLI directly. Git can address both the source and
  trunk worktrees through their explicit paths.

Regardless of harness, every later command that acts on the branch starts with
`cd "$WORKTREE"`, and Phase 4 starts from `MAINWT`. Shell state does not persist
between calls, so repeat the appropriate `cd` in each command.

## Phase 0: Preflight

Substitute the repo's trunk for `main` in every snippet if it differs. Run
this from `$WORKTREE`; `BRANCH` is the one Phase 0a captured, not whatever
`HEAD` says now.

```bash
set -euo pipefail

TRUNK=main
WORKTREE=<from Phase 0a>
BRANCH=<from Phase 0a>

cd "$WORKTREE"

command -v flock >/dev/null || { echo "ERROR: flock not installed (brew install flock)"; exit 3; }

[ "$BRANCH" = "HEAD" ] && { echo "ERROR: detached HEAD; check out the branch to land"; exit 3; }
[ "$BRANCH" = "$TRUNK" ] && { echo "ERROR: nothing to land; $TRUNK is the trunk"; exit 3; }
git show-ref --verify --quiet "refs/heads/$BRANCH" || { echo "ERROR: no such branch $BRANCH"; exit 3; }

for s in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
  [ -e "$(git rev-parse --path-format=absolute --git-path "$s")" ] && {
    echo "ERROR: $s in progress; finish or abort it before landing"; exit 3; }
done

MAINWT="$(git worktree list --porcelain | awk -v t="branch refs/heads/$TRUNK" '
  /^worktree /{wt=substr($0,10)} $0==t {print wt; exit}')"
[ -n "$MAINWT" ] || { echo "ERROR: $TRUNK is not checked out in any worktree"; exit 3; }
[ "$MAINWT" = "$WORKTREE" ] && { echo "ERROR: the branch to land lives in the $TRUNK worktree; land from a feature worktree"; exit 3; }

COMMONDIR="$(git rev-parse --path-format=absolute --git-common-dir)"

echo "branch=$BRANCH trunk=$TRUNK worktree=$WORKTREE mainwt=$MAINWT commondir=$COMMONDIR"
git status --porcelain=v1 -uall
git log --oneline "$TRUNK..$BRANCH"
```

Keep `MAINWT` and `COMMONDIR` from this run's output: Phase 4 pastes them in as
literals rather than re-deriving them.

The trunk-worktree check compares `MAINWT` against `WORKTREE`, not against the
current directory. Claude Code may now be in the trunk checkout, while Pi
remains in the source worktree. Either is valid because every command uses an
explicit path. What must not happen is landing a branch that is itself checked
out in the trunk worktree.

If Claude Code's isolation guard still refuses this script for being compound,
split it into plain one-line commands rather than rewriting it. Pi does not
attempt to lift isolation; run the same commands directly through the Git CLI.

`ERROR: main is not checked out in any worktree` has a lock-free variant; see
[references/contention.md](references/contention.md).

## Phase 1: Commit the worktree

Nothing lands that is not committed, and nothing is left behind. Default
behavior is unattended: stage everything not ignored and commit it.

Every command in Phases 1 through 3 runs in the branch's own worktree, so each
one starts with `cd "$WORKTREE"`. Claude Code may be in the trunk checkout and
Pi may remain in the source worktree; never rely on the session's current
directory.

1. Read the work before writing a message: `git diff`, `git diff --cached`,
   and `git ls-files --others --exclude-standard`.
2. **Refuse-to-add guard.** Scan the untracked list before `git add -A`:

   ```bash
   git ls-files --others --exclude-standard -z |
     while IFS= read -r -d '' f; do
       sz=$(wc -c <"$f")
       [ "$sz" -gt 1048576 ] && echo "LARGE $sz $f"
       case "$f" in
         *.env|*.env.*|*.pem|*.key|*.p12|*id_rsa*|*.keystore) echo "SECRET $f" ;;
       esac
     done
   ```

   Any hit stops the land. Report the paths and let the user ignore, delete, or
   explicitly stage them. Do not commit around the guard, and never reach for
   `--no-verify`.

3. Commit with a Conventional Commit message describing the change, not the
   act of landing:

   ```bash
   git add -A && git commit -m "<type>[scope]: <description>"
   ```

   Pre-commit hooks run. If a hook rewrites files, `git add -A` and amend. If a
   hook fails, fix the cause and retry; two failed rounds means stop and report.

4. Record `PHASE1_COMMIT=$(git rev-parse HEAD)` when this phase created a
   commit, and nothing if the tree was already clean. Phase 3 uses it to decide
   between amending and adding a commit.

If the tree was clean, say so and move on.

## Phase 2: Rebase onto local main

```bash
cd "$WORKTREE" && git rebase main
```

Local ref only. No fetch, and no `origin/main`: this skill integrates what is
on this machine.

**Clean replay:** go to Phase 3.

**Conflicts:** resolve them in `$WORKTREE`, never in the trunk. Use the
`resolving-merge-conflicts` skill. Resolve by reading both sides' intent
(`git log -p $(git merge-base ORIG_HEAD main)..ORIG_HEAD -- <file>` for your
side, the same range against `main` for theirs), never by picking a textual
winner. Then:

```bash
git add <resolved-files>
git rebase --continue
```

Grep for leftover `<<<<<<<`, `=======`, `>>>>>>>` before every `--continue`.

**Bail out** and stop the land when any of these hold: more than 10 conflicted
files, a conflict in a binary file, or a conflict in generated output
(lockfiles, `dist/`, `target/`, `.next/`). Leave the rebase in place, print the
conflicted paths and the `git rebase --continue` / `--abort` commands, and
report that `main` is untouched. It is: nothing has been written to it yet.

## Phase 3: Gates

Run what this repo runs before a push, in `$WORKTREE`. Skip only with
`--no-gates`.

Detection order, first hit wins:

| Signal                                    | Command                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `lefthook.yml` with a `pre-push:` section | `lefthook run pre-push`                                                      |
| `.husky/pre-push`                         | `./.husky/pre-push`                                                          |
| `justfile` with `check` or `test`         | `just check` then `just test`                                                |
| `package.json` scripts                    | format, then lint, then typecheck/check, then test                           |
| `Cargo.toml`                              | `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings`, `cargo test` |
| `Package.swift`                           | `swift build` then `swift test`                                              |
| `Makefile` with `check` or `test`         | `make check` / `make test`                                                   |

Use the package manager the lockfile implies. Run the writing formatter
(`bun run format`, `cargo fmt`) before its checking twin so a formatting
difference becomes a commit rather than a failure.

If no gate is detected, say so plainly in the report and continue. Never
report an undetected gate as passing.

**Gates that modify files.** After the run, `git status --porcelain`. If it is
non-empty:

- Tip commit is `PHASE1_COMMIT` from this run: `git add -A && git commit --amend --no-edit`.
- Otherwise: `git add -A && git commit -m "style: apply <tool> formatting"`.
  Never rewrite a commit this run did not create.

Then re-run the gates. Two fix rounds maximum; a third failure stops the land
with the failing output shown verbatim. `main` is untouched.

**Passing gates:** record the verified tree, which is what lets a later cycle
skip a redundant gate run.

```bash
VERIFIED_TREE="$(git rev-parse 'HEAD^{tree}')"
```

Caution in worktrees: hook runners export `GIT_DIR` into gate commands, and
`git -C <dir>` does not override it. A suite that shells out to git must
sanitize its environment or it will operate on this repository instead of its
fixtures.

## Phase 4: Land under the lock

One `Bash` call. Everything that touches `main` happens inside the lock; the
lock is held for a merge, not for a test suite.

Claude Code must leave native worktree isolation before this step; Pi runs it
directly with the Git CLI. Fill `BRANCH`, `LOCK`, and `MAINWT` in as **literal
paths** from the values Phase 0a and Phase 0 already resolved. Deriving them
here with nested `$(git ...)` can make Claude Code's command guard treat the
command as escaping the source worktree.

```bash
set -euo pipefail

TRUNK=main
BRANCH=<from Phase 0a>
LOCK=<COMMONDIR from Phase 0>/land-local.lock
MAINWT=<from Phase 0>

rc=0
flock -w 110 "$LOCK" bash -c '
  set -euo pipefail
  TRUNK="$1"; BRANCH="$2"; MAINWT="$3"
  cd "$MAINWT"
  DIRT="$(git status --porcelain)"
  [ -z "$DIRT" ] || { echo "REJECTED: $TRUNK worktree has uncommitted changes at $MAINWT:"; echo "$DIRT"; exit 4; }
  git merge-base --is-ancestor "$TRUNK" "$BRANCH" || { echo "REBASE_REQUIRED: $TRUNK advanced; rebase and retry"; exit 5; }
  OLD="$(git rev-parse --short "$TRUNK")"
  git merge --ff-only "$BRANCH" || { echo "ERROR: fast-forward merge failed unexpectedly"; exit 6; }
  NEW="$(git rev-parse --short "$TRUNK")"
  echo "LANDED: $TRUNK $OLD -> $NEW ($BRANCH)"
' _ "$TRUNK" "$BRANCH" "$MAINWT" || rc=$?
[ "$rc" -eq 1 ] && echo "TIMEOUT: lock held ~2 min; a land is likely wedged, investigate before retrying"
exit "$rc"
```

Why each piece is load bearing:

- **One lockfile per repository.** It lives in the common git dir, which every
  worktree shares, so all landers contend on the same file.
- **`flock` releases on process exit**, including crash or kill, so the lock
  cannot get stuck. A `-w 110` wait absorbs normal contention internally and
  stays under the Bash tool's 120s default so the `TIMEOUT` line wins.
- **Ancestor check and merge in the same locked block.** Checking outside the
  lock would be a race.
- **`--ff-only` cannot conflict.** That is the whole reason `main` stays clean
  for everyone else.

Read the outcome from the first word of the output, and never claim a land
without seeing `LANDED:` at exit 0. Full table in
[references/contention.md](references/contention.md).

## Phase 5: Loop or report

`REBASE_REQUIRED` (exit 5) is the contention path:

1. Decrement the attempt budget. Exhausted, report
   `main` is moving faster than this branch can verify, and stop. `main` is
   untouched.
2. Go back to Phase 2.
3. In Phase 3, if `git rev-parse 'HEAD^{tree}'` equals the `VERIFIED_TREE`
   from the previous cycle, the rebase produced an identical tree; skip the
   gate run and go straight to Phase 4.

Any other non-zero exit stops the land. Report the message verbatim.

On `LANDED`, report:

```
land-local
---
Branch:   <branch>  (<n> commits)
Main:     <old> -> <new>
Cycles:   <k> (rebase restarts: <k-1>)
Commits:  <created in Phase 1 / Phase 3, or "none">
Conflicts:<files resolved, with one line each on how, or "none">
Gates:    <command> PASSED | skipped (--no-gates) | none detected
```

State plainly that the branch is landed locally, that nothing was pushed, and
that the worktree and branch still exist.

## Boundaries

- Never touch `main` outside the locked block. No `git checkout main`, no
  cherry-pick into it, no merge commit, no `--no-ff`, no `--force`.
- Never fetch, push, or run `gh`. Landing is local.
- Never clean or stash the `main` worktree. A dirty `main` is a human's
  problem; report it verbatim and stop.
- Never delete the branch or its worktree. The user decides when that happens.
  On Claude Code, `ExitWorktree` is `action: "keep"` when it is needed. Pi does
  not call it.
- Never `--no-verify`. Gates exist to be passed.
- Never work around Claude Code's worktree isolation guard by moving a refused
  command into a script file and running that. If Phase 0a could not lift
  isolation, hand the user the Phase 4 block and stop. Pi uses the Git CLI
  directly and does not need this workaround.

## References

- [references/contention.md](references/contention.md): exit codes, why the
  lock spans only the merge, livelock behavior under heavy contention, and the
  variant for repos where `main` is not checked out.
