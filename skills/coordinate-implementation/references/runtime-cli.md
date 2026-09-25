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

## Results and the Engine guard

The coordinator loop that consumes these results is in
[SKILL.md](../SKILL.md#supervise-the-engine). A `wait` result carries a
`reason` (`attention`, `engine`, or `budget`), the most recent events since the
cursor with an `omitted_events` count, the Engine's liveness, and every open
escalation. `run.finalized` precedes `engine.completed` and reports the
finalize status.

While a live Engine holds the run, the helper CLI refuses every operation that
could race its writes with `engine.active`. Read-only checks,
`snapshot.accept`, and coordinator ownership operations stay available. Run
`stop` first before any manual recovery operation.

## Escalations

Anything outside the review and fix contract parks only its ticket and opens a
write-once record in `<run>/escalations/<id>.json`. Other tickets keep running
the whole time. Answer with `answer --id <id> --text "<decision>"`, adding
`--by user` when the text is the user's decision. Answers are immutable.

| Kind               | Raised when                                                             | What the answer does                                                                                                  |
| ------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `question`         | An implementor wrote its `TICKET BLOCKED` question file                 | Delivered to the implementor verbatim as the answer; the ticket resumes                                               |
| `stall_pause`      | The stall assessment selected `pause`                                   | Delivered to the implementor verbatim as a prompt; the ticket resumes under stall supervision                         |
| `snapshot_changed` | An input changed after acceptance; this holds new launches only         | Recorded only. The Engine re-checks the snapshot and escalates again until `snapshot.accept` records the new revision |
| `retry_exhausted`  | A launch, gate, or reviewer retry budget is spent, or the base is dirty | Recorded only. The ticket blocks; for a dirty base checkout, landing retries after the answer                         |

`review_churn` is not an escalation. The Engine emits `attention.review_churn`
when a ticket reaches the configured review round and keeps looping, because
review fixes are pre-authorized. To stop a churning ticket, run `stop` and
decide with the user. Scope questions arrive as `question` escalations, since
implementors resolve their own rebases.

## Script changes

`start` records the script's SHA-256 in the engine lease. If the script changes,
`start` fails with `engine.script_changed` until you pass
`--accept-script <new-sha>`. Scripts must be deterministic given step results:
after a restart the body runs again from the top, and built-in steps return what
RESUME.md and evidence already record.
