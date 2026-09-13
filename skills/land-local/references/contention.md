# Contention, exit codes, and locking

## Exit codes from Phase 4

| Output                             | Exit | Meaning and response                                                                                                                                                                                                |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LANDED: ...`                      | 0    | `main` now points at the branch tip, locally. If git said `Already up to date`, the branch was landed earlier; say so rather than claiming new work.                                                                |
| `TIMEOUT: ...`                     | 1    | Never acquired the lock in ~110s. Exceptional: normal contention clears in seconds, so a holder is wedged. Nothing changed. A human should look before a retry; do not silently loop.                               |
| `ERROR: ...`                       | 3    | Precondition failed (no `flock`, detached HEAD, `main` not checked out). Nothing changed.                                                                                                                           |
| `REJECTED: ...`                    | 4    | The `main` worktree has uncommitted changes. Relay the file list verbatim. Do not stash or clean it. If the paths do not look like they belong to that worktree, say so: a sandboxed filesystem view can fake this. |
| `REBASE_REQUIRED: ...`             | 5    | Another lander won the race. This is the normal loop signal, not a failure.                                                                                                                                         |
| `ERROR: fast-forward merge failed` | 6    | The ancestor check passed but the merge did not. Unexpected; report verbatim and stop.                                                                                                                              |

`flock` itself uses exit 1 for "timed out waiting", which is why the locked
block only ever exits 3, 4, 5, or 6. Do not add a path that exits 1.

## Why the lock spans only the merge

The lock is held across four git commands that take milliseconds. It is
deliberately not held across the rebase, the conflict work, or the gates.

Holding it through the gates would serialize landers on the slowest test suite
in the repo, which is the thing parallel worktrees exist to avoid, and every
other lander would hit the 110s wait and report `TIMEOUT`. The cost of the
short lock is that `main` can advance between the gate run and the merge
attempt. That cost is bounded: the ancestor check inside the lock catches it,
the merge is refused, and the cycle restarts. Losing the race costs one rebase;
holding the lock through gates would cost everyone the whole suite.

## Livelock

Under heavy contention a branch can lose the race repeatedly: each time it
finishes its gates, `main` has moved again. The attempt budget (default 3)
turns that into an honest report instead of an unbounded loop.

Two things make it rare in practice:

- A rebase onto advanced `main` that produces an identical tree skips the gate
  run entirely (`HEAD^{tree}` comparison in Phase 3), so no-op cycles cost a
  rebase and a merge attempt, nothing more.
- Landers finish at different times, so the race is not synchronized.

If the budget is genuinely exhausted, the honest answer is that this repository
is landing faster than this branch can verify itself. Options to give the
user, in preference order: rerun `/land-local` (cheap, the next race may be
won), run with `--no-gates` if the caller already verified the tree, or pause
the other landers. Do not respond by holding the lock through the gates.

## Stale locks

`flock` is a kernel-held advisory lock on an open file descriptor. It is
released when the holding process exits, including on crash, kill, or a
terminal being closed. There is no stale-lock cleanup to perform, and the
lockfile itself is never removed or truncated; only the lock on it matters.

A `TIMEOUT` therefore does not mean "a stale lockfile is lying around". It
means a live process has been inside the critical section for two minutes,
which four git commands cannot do. Look for a hung `git merge` in the `main`
worktree, or a debugger attached to a lander.

## When `main` is not checked out in any worktree

The Phase 4 snippet requires it, because a fast-forward has to update that
worktree's index and files as well as the ref. In a repo where `main` is not
checked out anywhere (a bare clone, or a worktree-only layout), the merge can
be replaced by an atomic compare-and-swap on the ref, with no lock at all:

```bash
OLD="$(git rev-parse refs/heads/main)"
git merge-base --is-ancestor "$OLD" "$BRANCH" || { echo "REBASE_REQUIRED"; exit 5; }
git update-ref -m "land-local: $BRANCH" refs/heads/main "$(git rev-parse "$BRANCH")" "$OLD"
```

`git update-ref <ref> <new> <old>` fails if the ref is not still at `<old>`,
and that check is atomic inside git's ref transaction, so it needs no external
lock. The loop semantics are identical: a failure means `main` advanced, so
rebase and retry.

Never use this variant while `main` is checked out. It moves the branch ref
without touching that worktree's index, so every landed file immediately shows
up as a reverse-diff modification there, which is exactly the dirty `main` this
skill exists to prevent.
