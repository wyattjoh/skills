# Runtime CLI

The runtime moves the core loop out of the coordinator's context. A detached
**Engine** runs the run's workflow script in its own Herdr tab, launches and
prompts every agent, runs gates, reads agent reports from files, and lands
tickets. The coordinator starts it once, then supervises through short,
bounded calls.

```bash
bun $SKILL_DIR/scripts/runtime.ts <command> --run .scratch/<slug> [flags]
```

Every command prints one JSON object: `{ "ok": true, "command", "result" }` or
`{ "ok": false, "command", "errors": [{ code, message, remediation }] }`. Exit
code 0 is success, 1 an operation failure, 2 a usage error.

## Commands

| Command  | Flags                                                                 | Effect                                                                                                                |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `start`  | `--script <run.ts>` `[--accept-script <sha256>]` `[--workspace <id>]` | Starts the engine in tab `engine <prefix>`, or attaches when a live engine already holds the lease. Safe to repeat.   |
| `wait`   | `[--cursor <n>]` `[--budget-minutes <m>]` or `[--budget-seconds <s>]` | Blocks until an attention event, engine trouble, or the budget (default 8 minutes, never above 9). Read-only.         |
| `answer` | `--id <escalation-id>` `--text <answer>` `[--by coordinator\|user]`   | Records the single answer to an open escalation. The engine delivers it to the parked ticket.                         |
| `status` | none                                                                  | Engine liveness, last event sequence, persisted cursor, open escalations, tickets, and active runtimes.               |
| `stop`   | `[--force]`                                                           | Asks the engine to stop after its current step. `--force` fences an unresponsive engine by claiming a new generation. |

`engine` is internal: `start` runs it inside the engine pane.

## The coordinator loop

1. `start` once. A `running` result means an engine already holds the lease; do
   not start another.
2. Call `wait`. Omit `--cursor` to resume from the cursor persisted by the last
   `wait`, which survives coordinator compaction and restarts.
3. Act on the result, then call `wait` again:
   - `reason: "attention"`: handle each `attention` event and each entry in
     `open_escalations` (below).
   - `reason: "engine"`: `engine.liveness` is `stale`, `released`, or `none`.
     Run `start` again with the same script. It reconciles from RESUME.md and
     evidence, and nothing that already happened repeats. `engine.unresponsive`
     means the process is alive but silent: run `stop --force`, then `start`.
   - `reason: "budget"`: nothing needs you. Report progress briefly if useful and
     wait again.
4. Stop when `engine.completed` arrives. The preceding `run.finalized` event
   reports the finalize status: `completed` means `SUMMARY.md` is written;
   `waiting` lists blocked tickets to resolve and restart, or to close with the
   user's explicit decision through `run.finalize`.

Never poll with sleeps, cron, or background shells. `wait` is the only wait.

While a live Engine holds the run, the helper CLI refuses every operation that
could race its writes with `engine.active`. Read-only checks,
`snapshot.accept`, and coordinator ownership operations stay available. Run
`stop` first before any manual recovery operation.

## Escalations

Anything outside the review and fix contract parks only its ticket and opens a
write-once record in `<run>/escalations/<id>.json`:

| Kind               | Raised when                                                      | Who answers                                                   |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `question`         | An implementor wrote a `TICKET BLOCKED` question file            | Coordinator from the spec and tickets; otherwise ask the user |
| `scope`            | A rebase or review needs a product scope decision                | User                                                          |
| `snapshot_changed` | `spec.md`, `snapshot.json`, or a ticket changed after acceptance | User, through the snapshot acceptance flow                    |
| `retry_exhausted`  | A launch, gate, reviewer, or Herdr retry budget is spent         | User                                                          |
| `review_churn`     | A ticket reaches the configured review round                     | Coordinator; the engine keeps looping unless told otherwise   |
| `stall_pause`      | The stall assessment selected `pause`                            | Coordinator after reading the pane, or the user               |
| `report_missing`   | An agent went idle without writing its required report file      | Coordinator after reading the pane                            |

Answer with `answer --id <id> --text "<decision>"`. Pass `--by user` when the
text is the user's decision. Answers are immutable. Other tickets keep running
the whole time.

## Script changes

`start` records the script's SHA-256 in the engine lease. If the script changes,
`start` fails with `engine.script_changed` until you pass
`--accept-script <new-sha>`. Scripts must be deterministic given step results:
after a restart the body runs again from the top, and built-in steps return what
RESUME.md and evidence already record.
