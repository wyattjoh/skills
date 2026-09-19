# Pause, migration, and wind-down

Use when the user asks every run to stop for a machine move, filesystem
snapshot, cost pause, or break. Record the user's exact stopping rule before
sending anything.

## Safe-point rule per run

- No new ticket starts.
- The in-flight coordinator-owned synchronization, review, fix, landing, or
  handoff action reaches a durable boundary.
- Each worker is either safely stopped or represented by complete committed or
  uncommitted recovery state in the run-owned RESUME.md.
- No repository gate or build remains active in that run's worktrees.
- The run outcome and registry row say `waiting` when unfinished. They never say
  `completed` merely because execution paused.
- Ticket worktree cleanup follows the run's persisted repository policy. The
  core coordinator never removes one.

## Procedure

1. Stop launching new cross-run actions and persist the requested pause rule in
   your RESUME.md.
2. Send every ready run owner one equivalent safe-point request and ask for its
   persisted state line in reply.
3. Continue the normal event-driven observation cycle with only pause-related
   wakes. Do not create a second polling or background loop.
4. Record each acknowledgement. If a run receives a different direct user
   instruction, that user decision wins and the other runs must be aligned.
5. Report interim per-run state honestly until every run satisfies the rule.
6. Report `PAUSED` only after every run's persisted state and Herdr snapshot
   agree, then stop the event subscription.

## PAUSED report

Use one line per run with its status, active or blocked ticket, branch and SHA,
uncommitted recovery note when present, retained worktree, ownership generation,
and anything a successor must resolve. Include pending tracker actions but do
not execute them.

Disk cleanup is owned by each run under repository policy. Ask the run owner to
perform approved cleanup at a safe point. Never start a watcher or command loop
that races a live build.
