# Automatic safe coordinator handoff

Use this protocol whenever the selected Coordinator role differs from the
invoking session and whenever the current coordinator reaches the context
threshold. Pi and Claude Code follow the same protocol in all four predecessor
to successor combinations.

The selected `Coordinator:` record must already be validated and persisted.
Never rewrite it to make the current pane appear to match. The predecessor stays
open until the helper authorizes its exact close command.

## Detect the threshold from Herdr

Every `herdr.wait_any` request includes the current coordinator as well as all
active workers:

```json
{
  "schema_version": 1,
  "operation": "herdr.wait_any",
  "input": {
    "socket_path": "/path/to/herdr.sock",
    "timeout_ms": 600000,
    "workers": [],
    "coordinator": {
      "session": "coordinator-example-4",
      "pane_id": "w1:p1",
      "phase": "waiting"
    }
  }
}
```

The helper reads only the coordinator agent's normalized `context_used` and
`context_limit` fields from the machine-readable Herdr snapshot. It never reads
rendered status or pane text. Missing or invalid values fail with
`herdr.context_missing` even if the terminal visibly shows a percentage.

The threshold is exactly 80 percent, calculated by `BigInt` cross-multiplication
for every accepted safe integer:

- below 80 percent returns `handoff: continue`;
- at or above 80 percent in `waiting` or `scheduling` returns
  `reason: handoff` and `handoff: required`;
- at or above 80 percent in `synchronizing`, `reviewing`, `fixing`, or `landing`
  returns `handoff: deferred` and does not interrupt that action.

Finish an unsafe action, do not start another ticket, and repeat the check at
the next safe point. Active workers do not need to finish first.

## Prepare a shell-free successor launch

Split a successor pane in the current coordinator tab with no focus change and
read its machine-readable pane id. Then call `coordinator.handoff.prepare` with
the predecessor Herdr session and socket. The helper:

1. validates canonical schema-1 RESUME.md and the ready predecessor ownership;
2. reads the persisted Coordinator harness, model, and effort;
3. independently re-observes the predecessor's normalized Herdr context and
   enforces the 80 percent threshold and safe phase;
4. constructs exact Herdr and harness argument arrays through the shared launch
   adapter;
5. atomically publishes an inspectable run-local artifact without overwriting a
   concurrent attempt and without changing ownership.

Execute `launch.start` and `launch.prompt` as argument arrays. Never join,
quote, interpolate, or pass them through a shell. Pi receives `--approve`, its
persisted model, and `--thinking`. Claude Code receives its persisted model,
`--effort`, and `--permission-mode auto`.

If pane creation, agent start, or prompt submission fails before the claim,
close only the failed successor pane and call `coordinator.handoff.retry` with
the artifact and exact diagnostic. The helper atomically publishes immutable
`<artifact>.retry.json` evidence bound to the artifact SHA-256, preserving that
diagnostic and the complete retry decision. Byte-identical recovery succeeds;
a changed diagnostic or decision at the same evidence path fails closed.
Attempts 1, 2, and 3 return the shared 1000, 2000, and 4000 millisecond delays.
Attempt 4 returns `action: block`. Each retry must pass the preceding artifact
to `coordinator.handoff.prepare`; the helper
rejects a changed run, predecessor generation, or successor role. Ownership
continues to name the ready predecessor throughout these retries.

## Successor recovery and atomic claim

The successor performs these steps in order:

1. Run `state.validate` against RESUME.md.
2. Run `snapshot.check` and require `status: unchanged` with
   `scheduling_allowed: true`.
3. Invoke `coordinator.handoff.ready` with the launch artifact, Herdr socket,
   bounded timeout, and authoritative project remote-write policy.

`coordinator.handoff.ready` validates the run-local artifact against the ready
predecessor and persisted Coordinator role, validates the accepted snapshot
again, requires unique one-based active runtime identities that match active
ticket-table rows in RESUME.md, and subscribes before snapshotting through
wait-any. Under the same state lock as ownership transition, it requires the
complete current active-runtime identity set to exactly match that pre-wait
set. Only after every worker is present does that mutation refresh compacted
worker panes, compare-and-swap the predecessor generation, and record the
successor as ready. A stale generation,
changed snapshot, invalid state, missing worker, changed successor pane, or
successor already at 80 percent fails before ownership changes. Never retry with
guessed values.

After success, print one line containing only:

```text
COORDINATOR READY <marker>
```

The automatic handoff operation never exposes a separate claiming interval.

## Predecessor verification and exact close

The predecessor reads a bounded tail from the exact successor pane and copies
the marker from its `COORDINATOR READY` line. It then calls
`coordinator.handoff.verify` with the successful launch artifact and that
independently observed marker.

Verification requires all of the following:

- state still names the artifact's successor generation and pane;
- the bound harness, model, and effort match the artifact;
- readiness is `ready`;
- the observed marker exactly matches durable state.

Only a successful result contains `close_predecessor: true` and an exact
`{"command":"herdr","args":["pane","close","<predecessor-pane>"]}` command.
Execute that array only after updating the run registry to the successor pane.
Do not construct a close command independently.

A timeout, missing marker, stale artifact, `claiming` state, changed snapshot,
missing worker, or mismatched role keeps the predecessor open. Recover the
current claimant when possible. Otherwise launch a replacement from the owner
currently recorded in state.

## Binding rules

- Automatic handoff is enabled for both supported harnesses at exactly 80
  percent normalized utilization.
- Coordinator changes always use this protocol.
- Existing implementor and reviewer sessions keep their bound role records.
- Future launches use the current run-wide role defaults.
- A failed successor never triggers harness, model, or effort substitution.
