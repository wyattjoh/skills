# Coordinator continuity on Herdr 0.9.1

Herdr 0.9.1 exposes machine-readable worker status, pane identity, snapshots,
and subscription events. It does not expose normalized model context usage or
context limits. The coordinator therefore cannot implement a trustworthy
percentage-triggered handoff.

Record this exact policy in every new run:

```text
Coordinator:
  handoff:    disabled
  threshold:  unavailable
```

Never parse rendered pane output, terminal titles, status text, or token
metadata to estimate context utilization.

## Continue through normal compaction

Keep the current coordinator session open and allow Pi or Claude Code to use its
normal compaction behavior. Before ending any turn:

1. finish the current coordinator-owned synchronization, review, fixing, or
   landing action;
2. persist every active runtime, pane, branch, review result, and decision in
   RESUME.md;
3. keep the accepted snapshot revision current;
4. report the next dependency-ready action.

Compaction alone is not a coordinator failure and does not authorize a new
session or pane.

## Recover an ended coordinator

Use `resume .scratch/<slug>` only after the previous coordinator process has
ended or cannot recover. The replacement:

1. runs `preflight`, `state.validate`, and `snapshot.check`;
2. confirms the previous coordinator process is no longer active in Herdr;
3. refreshes every active worker pane from a bounded `herdr.wait_any` call with
   `coordinator: null`;
4. claims the next coordinator generation with the existing compare-and-swap
   ownership operations;
5. marks the new generation ready and records its marker;
6. runs `scheduler.plan` from the durable dependency frontier.

Do not relaunch workers that remain present in Herdr, even when compact pane ids
changed. Do not close a live predecessor to make a replacement claim succeed.

## Unsupported automatic operations

New runs must not invoke `coordinator.handoff.prepare`,
`coordinator.handoff.retry`, `coordinator.handoff.ready`, or
`coordinator.handoff.verify`. Those compatibility operations require a legacy
run state that explicitly records `handoff: yes` and normalized Herdr context
metrics. A new `handoff: disabled` run fails preparation with
`coordinator.handoff_disabled` before creating an artifact or launching a
successor.

## Binding rules

- Coordinator role changes still require validated ownership takeover.
- Existing implementor and reviewer sessions keep their bound role records.
- Future launches use the current run-wide role defaults.
- A coordinator restart never authorizes harness, model, or effort
  substitution.
- Durable state and Herdr's machine-readable worker identities are authoritative.
