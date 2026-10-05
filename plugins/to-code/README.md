# to-code fleet adapters

Pi's async coordinator and workers share the production statecharts in `fleet/model.ts` with the offline simulator. The Claude mod and unmanaged Pi fleets retain the dependency-free legacy `hooks/core/` tools. A Herdr pane becoming idle is never an async outcome.

## Pi async protocol

Use the @earendil-works Pi CLI 1.0.2 or newer inside Herdr. Async startup checks the actual host package, not the plugin's dev dependency. Unknown embedded hosts fail closed. Install this package's pinned dependencies before loading `pi/index.ts`. Do not load multiple copies of the extension.

The coordinator owns scheduling, questions, and serial integration. Workers receive an existing ticket worktree, explicit model/thinking configuration, and one assignment ID. Startup uses a new background tab (`--no-focus`) in the coordinator-selected existing workspace, without creating a branch or worktree:

```text
pi --extension <plugin>/pi/index.ts --model <provider/model> --thinking <level>
   --fleet-run <absolute-run-directory> --fleet-implementor <worker-id>
```

A reviewer uses `--fleet-reviewer` instead. Only one role flag is allowed. Launch acknowledgment requires a flag-bound live process and ready callback endpoint, not just a terminal readiness marker. An ambiguous launch is retained as `uncertain`; inspect it before restarting, never repeat allocation blindly.

### Coordinator tools

| Tool                   | Required input and meaning                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fleet_setup`          | `workspace`, `integrationBranch`, `checks`, optional `commandTimeoutMs` (1..570000). Cwd must be the integration worktree; `.scratch/` must be Git-ignored.                                                                          |
| `fleet_start_ticket`   | `fleetId`, `ticketId`, `worktree`, `goal`, `model`, `thinking`. The supplied worktree must be clean, separate, already created, and share the Git common directory. Ticket IDs are plain tokens.                                     |
| `fleet_start_review`   | `fleetId`, `ticketId`, `model`, `thinking`. Requires verified implementation evidence. Reuses the retained reviewer on a refreshed implementation, keeping its recorded configuration.                                               |
| `fleet_send`           | `fleetId`, `workerId` (or owned `pane`), `text`, optional `questionId`. Answers require the exact pending question ID. Dispatch rearms the stop gate with a new assignment.                                                          |
| `fleet_finish_ticket`  | `fleetId`, `ticketId`. After the coordinator lands the approved head, verifies immutable approval, unchanged source head, fresh source/integration checks, a clean integration worktree, and ancestry before retiring owned workers. |
| `fleet_resume`         | Canonical absolute `directory`. Reopens session-owned callbacks and replays pending applicable notifications; never takes over a live/ambiguous owner.                                                                               |
| `fleet_restart_worker` | `fleetId`, `workerId`. Reconciles a confirmed existing instance or restarts an absent worker in its recorded pane/configuration. Never allocates replacement Git resources.                                                          |

`fleet_status` returns snapshots, assignment IDs, launch/transport state, and pending callbacks. `fleet_read` is an owned-worker diagnostic, not a result source. Managed `fleet_wait`/`fleet_watch` return an error: use callbacks, not completion polling. Finish/account for legacy watches before switching modes.

If Git changes during review or approval, `fleet_send` explicitly supersedes stale work, invalidates the old ticket evidence, and assigns implementation re-verification. A reviewer question on a changed snapshot also takes this route. Superseding is a durable control outcome, not reviewer approval or failure. Old replies and reports cannot clear a newer assignment's gate.

### Worker tools

| Tool                   | Input and meaning                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet_question`       | `reportId`, `assignmentId`, `question`. Persists a coordinator question before permitting accounted waiting.                                                                       |
| `fleet_report`         | `reportId`, `assignmentId`, `outcome`, `summary`, optional `filename`. Implementor outcomes: `completed`, `failed`, `approval`. Reviewer outcome: `review` with the assigned file. |
| `fleet_request_review` | `reportId`, `assignmentId`, `summary`. After fixing validated findings, checks the changed implementation and rearms the retained reviewer.                                        |

Report IDs are unique per worker across assignments. Identical retries are idempotent; changed payloads or stale assignment IDs are rejected. No final chat message, bare approval, or Herdr terminal state substitutes for these tools. Every active assignment remains stop-guarded at `agent_before_settle`; accounted questions, reports, supersession, and recorded control faults may wait. A recorded `Lost` fault is not ticket completion.

All worker questions route to the coordinator. Native UI questions are surfaced there, but answers do not grant native permissions or resolve human confirmation dialogs. Abort/error/no-continuation paths preserve a control-fault callback without fabricating a reviewer result. Hard crashes outside lifecycle hooks need coordinator inspection/recovery.

### Review contract

The worker binding supplies the exact relative `.scratch/.../reports/<worker>-<assignment>.md` path and this template:

```markdown
# Review

ticket: T1
reviewer: r123
assignment: a-456
base: <assigned-base>
head: <assigned-head>
verdict: approved

## Findings

None.
```

Use `changes_requested` with `- [medium|high|critical] <actionable finding and location>` when blocking fixes are needed. Low suggestions may accompany approval. Exactly one metadata value and Findings section are required. Assignment, reviewer, ticket, filename, base, and head must match the live binding. Canonical file reads reject traversal, symlinks, nonregular/outside files, and files over 1 MiB.

Findings go directly to the implementor. The implementor fixes them and requests re-review; the same reviewer remains assigned. Approval goes to the implementor, who forwards `outcome: approval` to the coordinator. Accepted file digests are rechecked for re-review, forwarding, and landing. Validation proves structure and evidence binding, not the semantic quality of a review.

## Durability and recovery

Each Git-ignored run lives at `<integration-worktree>/.scratch/to-code/async-<uuid>/`. `state.json` stores schema-decoded Machine snapshots, resource ownership, immutable report records, and a callback outbox. Updates use a bounded cross-process lock and fsync/atomic rename on a local filesystem. Proven-dead same-host writer locks are archived; live, remote, or ambiguous locks fail closed. Preserve archived locks and scratch evidence for investigation.

Callbacks are at least once. Session-owned Unix sockets (Windows named-pipe addressing is also defined) announce durable work, with no detached daemon. A queued `sendMessage` is not delivery: only a persisted Pi custom-message entry acknowledges its outbox ID. Duplicate/stale notifications are deduplicated or marked obsolete; offline recipients replay from durable state on resume. No managed-worker completion timer is used.

Takeover requires the recorded host and repository identity and a proven absent predecessor. Preserve worktrees, branches, reports, and unrelated panes. Cleanup happens only after durable `Landed`; failures are separately retryable. Close only the exact owned, settled Pi pane, and close its tab only if it contains no other pane. Role checks and filesystem validation are workflow safeguards, not an OS security sandbox.

## Shared simulator and checks

From the repository root, `bun plugins/to-code/demo/build.ts` writes `.scratch/fleet-state-machine.html`. Open it directly: the generated HTML contains its own script and styles, imports the production model/validator through the build, and needs no network or install on the viewing machine. Its Git, checks, transport, and panes are simulated, not claims about real Herdr behavior.

Run `bun test plugins/to-code/fleet plugins/to-code/pi plugins/to-code/hooks/core plugins/to-code/demo`, plus root `check`, `lint`, and formatting. Claude mod tests still use `claude plugin test plugins/to-code`. Live Herdr launch validation must run inside Herdr, against a human-selected workspace and disposable already-created worktree; fixtures alone do not prove the live launcher contract.
