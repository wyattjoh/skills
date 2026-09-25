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
normal compaction behavior. The Engine owns ticket progress in its own tab, so
compaction never interrupts a launch, gate, review, or landing. Before ending
any turn:

1. answer or record every escalation you already decided;
2. persist every stated preference and decision in RESUME.md;
3. keep the accepted snapshot revision current;
4. report the next pending escalation or the run's progress.

The next `runtime.ts wait` without `--cursor` resumes from the persisted Event
Cursor, so no attention event is lost across compaction. Compaction alone is
not a coordinator failure and does not authorize a new session or pane.

## Recover an ended coordinator

Use `resume .scratch/<slug>` only after the previous coordinator process has
ended or cannot recover. The Engine keeps running meanwhile and parks any
ticket that needs an answer. The replacement:

1. runs `preflight`, `state.validate`, and `snapshot.check`;
2. confirms the previous coordinator process is no longer active in Herdr;
3. claims the next coordinator generation with the existing compare-and-swap
   ownership operations;
4. marks the new generation ready and records its marker;
5. runs `runtime.ts status`, then `runtime.ts start` with the recorded
   `run.ts`, which attaches to a live Engine or reconciles a new generation
   from RESUME.md and evidence;
6. resumes the `runtime.ts wait` loop and answers every open escalation.

Do not relaunch workers that remain present in Herdr; the Engine refreshes their
pane ids from its Herdr subscription. Do not close a live predecessor to make a
replacement claim succeed.

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
- The coordinator generation and the Engine Lease generation are independent. A
  coordinator replacement never claims or releases the Engine Lease.
