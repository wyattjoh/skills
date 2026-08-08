# Orchestration loop

The coordinator's state machine, and the failure modes that are specific to
running workers as real OS processes rather than in-process subagents.

## Ticket states

| State       | Meaning                                                   | Left by                                 |
| ----------- | --------------------------------------------------------- | --------------------------------------- |
| `pending`   | Not started; may be waiting on dependencies               | a free slot and all dependencies merged |
| `spawning`  | Worktree and tab created, agent starting                  | `spawn.ts` succeeding, or failing       |
| `working`   | Brief accepted, worker implementing and self-reviewing    | the worker's report arriving            |
| `reported`  | Report received, not yet checked                          | the coordinator verifying it            |
| `verifying` | Coordinator running the gate and inspecting the diff      | the gate passing or failing             |
| `merged`    | Integrated into the target branch; terminal               | —                                       |
| `escalated` | Review or verification exhausted; terminal                | —                                       |
| `blocked`   | Worker reported blocked, or a dependency failed; terminal | —                                       |
| `failed`    | Spawn failed or the worker died; terminal                 | —                                       |

Only `merged` releases dependents. A dependent of an `escalated`, `blocked`, or
`failed` ticket is marked `blocked` by `roster.ts propagateBlocks`, because
building on unreviewed work is how a batch produces a branch nobody approved.

## The loop

Repeat until every ticket is terminal:

1. **Fill slots.** While `availableSlots > 0` and `readyTickets` is non-empty,
   dispatch the next ready ticket.
2. **Wait for an event.** Either a worker's peer message arrives, or a stall
   check fires (below).
3. **Handle the event**, rewrite the roster, and go back to step 1.

Dispatch, per ticket:

1. `pando create <branch>` from the repo root, capturing the worktree path from
   the JSON output. Record `worktree`, `branch`, and the worktree's starting SHA.
2. Compose the brief from `references/worker-brief.md` and write it to
   `.herd/<batch>/<ticket-id>/brief.md`.
3. `spawn.ts` → tab, agent, brief submitted. Record `peerName`, `tabId`,
   `paneId`, `kind`, `agent`, `model`, `effort` **immediately**; these cannot be
   reconstructed after a compaction.
4. Set status `working`.

On a `done` report:

1. Read the diff yourself. Do not trust the report's `filesChanged` — verify it
   against `git diff --name-only`.
2. Confirm the worker stayed inside its worktree. A commit touching another
   ticket's files is an escalation, not a merge.
3. Run the verification gate yourself in the worktree.
4. `cd <worktree> && pando merge` to integrate into the target branch. `pando
merge` squashes and removes the worktree by default; pass `--no-squash` when
   the ticket's individual commits are worth keeping.
5. `herdr tab close <tabId>`, set `merged`, record `mergedSha`, re-evaluate the
   ready set.

On a `blocked` report: set `blocked`, retain the worktree and the tab so the
work is inspectable, and surface it to the user. Do not close the pane.

## Failure modes specific to real sessions

**A worker that never reports.** In-process subagents always return; an OS
process can sit at a prompt forever. Poll with
`herdr agent wait <peer> --until blocked --timeout <ms>` or read
`herdr agent list` and compare `agent_status`. A worker in `blocked` is waiting
on a permission prompt or a question; read its pane with
`herdr pane read <paneId> --source recent --lines 80` to see what it is asking,
then answer it with `herdr agent prompt`. A worker in `idle` that sent no report
has finished its turn without following the brief — re-prompt it once with a
reminder to send its report, and escalate if it does so again.

**Prefer messages over screen scraping.** `herdr pane read` returns rendered
terminal text: wrapped, truncated, and full of TUI chrome. Use it to diagnose a
stalled worker, never as the completion signal. The peer message is the
authoritative report.

**A pane the user closed.** If `herdr agent list` no longer shows a worker's
peer, treat the ticket as `failed`. The worktree survives, so the work is not
lost; re-dispatch only after checking whether the branch already has commits.

**Name collisions.** Two live sessions with the same peer name make
`SendMessage` ambiguous for the rest of the run. `preflight.ts` reports
`livePeers`; check the generated worker name against it before spawning, and
suffix on collision.

**A worker that messages you mid-flight.** Workers are told to report once, but
a confused one may ask a question instead. Answer it over `SendMessage` — that
keeps its context — rather than re-prompting through herdr.

## Escalation

Escalate rather than retry when the worker hit the review cap, when the
verification gate fails on work the worker believes is done, or when the diff
touches files outside the ticket's scope. In every case: retain the worktree,
retain the tab, record the outstanding comments in the roster, hold dependents
blocked, and report the worktree path so the user can finish it by hand.

Never silently re-dispatch a ticket that already has commits on its branch. Send
the existing worker follow-up comments instead; it still has the context that
produced the diff.

## Resumption

The roster is the only durable record. On resume:

1. `roster.ts summary` for the recorded state.
2. Reconcile against git: any ticket whose branch is already merged into the
   target is `merged`, whatever the roster says. Git wins on "merged".
3. Reconcile against herdr: for each non-terminal ticket with a `peerName`,
   check `herdr agent list`. Present and alive → the worker survived; message it
   to ask for status rather than restarting it. Absent → `failed`.
4. Re-derive the ready set and continue.

Never double-dispatch. A ticket with a live peer is resumed, not restarted.
