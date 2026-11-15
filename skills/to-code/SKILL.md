---
name: to-code
description: Coordinates local spec and ticket implementation through Pi or Claude Code workers in Herdr, with parallel implementation, per-ticket review, and serial integration onto a dedicated run branch. Use for "/to-code", "implement the tickets in", "orchestrate the run", or "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>]"
compatibility: Requires Git, a Herdr-managed pane, the herdr skill, and the chosen worker harnesses (Pi or Claude Code).
disable-model-invocation: true
user-invocable: true
---

# Coordinate implementation

Coordinate the local spec and tickets in `$ARGUMENTS`. The goal is a verified
implementation on a dedicated run branch, not trunk. Delegate implementation
and review; you own coordination and landing. Use the `herdr` skill and project conventions.

Tickets form a **dependency graph**. Run its ready frontier in parallel;
dependencies are satisfied when tickets land. The cap counts tickets through
review and landing, excluding blocked tickets while their workers wait.

Communicate through **context pointers**, not duplicated briefs. Keep decisions,
worker identities, results, and next actions in a concise `RESUME.md` using
[resume.md](references/resume.md).

When `fleet_start_ticket` is available, use the Pi callback protocol in
[pi-async.md](references/pi-async.md). Select an existing Herdr workspace explicitly;
managed workers report durable outcomes and questions, then callbacks wake you.
Use snapshots and evidence for progress, never managed-worker completion polling.

Otherwise, supervise workers through bounded Herdr waits. On state changes or
timeouts, reconcile unfinished tickets with worker results and Git state. Idle
is not complete: inspect what remains, continue its assignment, or surface its
blocker. Finish only when every ticket is accounted for.

In this legacy branch, when `fleet_*` tools are present, call
`fleet_setup` with this run's worker pane IDs and pass the returned `fleetId` to
subsequent tools. The fleet follows all agents in those panes' Herdr workspaces,
including new workers; keep unrelated work in separate workspaces. Use `fleet_send`
to prompt workers (it watches the pane), `fleet_watch` for panes dispatched
otherwise, and `fleet_wait`/`fleet_status` to reconcile. A watched pane wakes this
session when it settles, so end the turn instead of polling. Recreate the fleet
and watches after a coordinator handoff or an unknown-ID error. Without the tools,
use bounded `herdr agent wait` calls.

## Workflow

1. Read the spec and tickets. Agree on the Herdr workspace, integration branch/worktree, ticket
   worktree location, implementor/reviewer harness/model/effort defaults, and cap. Approval
   covers routine ticket setup.
2. Give each implementor its own branch, worktree, and Herdr tab. Implementors
   own code, commits, checks, and rebase conflicts.
3. Give each ticket **one fresh, read-only reviewer** for Standards, Spec, and
   check evidence. Return medium-or-higher findings to the implementor and review
   fixes. Low-severity suggestions do not block landing.
4. When integration advances, have implementors rebase and rerun checks. Renew
   review for conflicts, substantive changes, or uncertainty. Async Pi binds approval
   to exact evidence, so any reviewed head/base change before landing needs fresh review.
5. **Land serially yourself with `git merge --ff-only`**, keeping implementation
   and review parallel. Async Pi verifies with `fleet_finish_ticket` and retires only
   owned, accounted sessions; preserve worktrees, branches, and results. In the
   legacy branch, safely clean up idle ticket sessions and approved clean worktrees.
   Launch newly unblocked work.
6. Once all tickets land, verify the integrated branch, delegate any fixes,
   and write `SUMMARY.md`.
   Offer trunk integration separately; trunk merges and remote writes require
   explicit authorization consistent with project policy.

## Continuity

For `resume <folder>`, reconcile the handoff with Git and living workers.
Legacy runs can replace a dead coordinator with either harness without its chat
history. Async Pi runs resume through `fleet_resume` in a supported Pi coordinator;
changing to legacy supervision is an explicit migration, not automatic fallback.
**Always ask once before migrating affected workers** to another harness,
model, or effort.
