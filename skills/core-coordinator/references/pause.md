# Pause, migration, and wind-down

Use when the user asks every run to stop: a machine move, a filesystem
snapshot, a cost pause. The user's exact words decide how far each run goes
before stopping; write that down before sending anything.

## Safe-pause rule (per run)

- No new ticket starts.
- The in-flight ticket either lands (when the user allows finishing it) or
  stops at its current step with the worker idle, its work committed on the
  ticket branch, or its uncommitted edits listed in RESUME.md.
- No cargo/rustc/just process is running in any of the run's worktrees.
- Progress loop, stall check, and background monitors are stopped.
- RESUME.md carries a dated "paused for <reason>" section with ticket, branch,
  last commit, what remains, pane id; the registry line matches.
- Base worktrees are never removed. Ticket worktrees are removed after a
  landing only if the user has not suspended removal; ask when unclear.

## Procedure

1. Delete the standing loop and schedule the wind-down loop below.
2. Send every coordinator one identical order: what to finish, what to stop,
   the safe-pause rule, and "reply with your state line when stopped".
3. Record each acknowledgement in RESUME.md. A coordinator that takes the
   question to the user and gets a different answer wins; align the others.
4. When a migration session or a second user session asks for status,
   answer with an interim per-run state before all runs are stopped, and
   say plainly that it is not yet PAUSED.
5. When every run meets the rule, send one `PAUSED` message (to the user and
   to any requesting session) with one line per run: ticket, branch, sha or
   "uncommitted with note", and anything a successor on the new machine must
   know. Then delete the wind-down loop.

## Wind-down loop

`CronCreate`, recurring, off-minute ten-minute cadence, prompt:

> Core coordinator wind-down check. For each run coordinator pane and its
> worker pane: `herdr pane read <pane> --lines 40 --source recent`. List
> builds: `pgrep -f 'bin/(cargo|rustc)'` and map each pid's cwd with
> `lsof -a -p <pid> -d cwd -Fn`; a build inside a ticket worktree means that
> run is not paused. In each ticket worktree: `git status --short` and
> `git log --oneline <base>..HEAD`. Read each run's RESUME.md for the paused
> section and check its registry line. Apply the safe-pause rule from the
> core-coordinator skill's pause reference. Restate the rule once to any run
> that has not acknowledged. Record per-run state in your RESUME.md. When all
> runs meet the rule, send PAUSED with one line per run, then CronDelete this
> job and tell the user. Never remove worktrees or run builds yourself.
> Report in three lines or fewer when nothing changed.

## Cleaning disk before a snapshot

`cargo clean` in a worktree with a live build kills the worker's build. Ask
each coordinator to clean at its worker's next idle point, or, when the user
asks you to do it, run a watcher per worktree that polls for no cargo/rustc
process with that worktree as cwd and then runs `cargo clean`. Report sizes
before and after; a worker resumes building immediately, so the space comes
back only once the run is paused.
