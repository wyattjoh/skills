# Event-driven observation cycle

Arm one bounded Herdr event wait over every run coordinator pane from the
repository's global run files. Subscribe before taking the immediate machine-readable
snapshot so a completion or pane-exit event cannot be lost during bootstrap.
Use normalized agent status fields only. Never parse rendered
terminal lines for status or context use.

Wake on:

- a run coordinator becoming idle, blocked, done, or exited;
- a cross-session message from a run owner;
- a run owner message reporting a persisted state change;
- a bounded timeout with a complete pane snapshot;

After each wake:

1. reread the repository's global run files, the agreements file, and your
   RESUME.md;
2. read each referenced schema-1 run state without modifying it;
3. verify each run file's prefix, base, ownership generation, ready pane, run
   status, and active ticket set against that state;
4. ask the owning run coordinator to repair drift;
5. apply merge order, shared-file, conflict-watch, relay, pause, and completion
   duties;
6. persist only cross-run decisions and observations you own;
7. arm the next bounded event wait when active or waiting runs remain.

On timeout, check missing panes, unchanged ownership generations, heartbeats
older than twice each run's stall interval, local diff footprints, and pending acknowledgements. A timeout never means a run completed. Send at most one
bounded continuation message to a healthy but idle owner. Escalate a missing or
repeatedly unhealthy owner to the user rather than relaunching it with guessed
configuration.

When no active or waiting run remains, verify every completed run has a local
SUMMARY.md, record its outcome and pending tracker action, and stop the cycle.

This cycle is event-driven. Do not replace it with cron, scheduled prompts,
background shell processes, sleep loops, harness-native task queues, or repeated
pane-tail polling.
