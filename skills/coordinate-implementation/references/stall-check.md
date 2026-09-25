# Stall check

The Engine runs this check on its own per-ticket timer, every persisted
`Stall interval:` (10 minutes by default), from a worker's launch until its
ticket lands or parks. It also checks a worker that settles `idle` or `done`
without being review-ready (a clean worktree with at least one ticket commit
beyond the base). The coordinator never runs the check and never adds a timer,
cron, or scheduled prompt for it; it sees only the resulting `stall_pause`
escalations through `runtime.ts wait`.

TypeSafe has semantic authority only inside this bounded seam. Pinned model
`jev-1.13.0` estimates five probabilities from a bounded `StallState` (ticket
criteria, the bound role and status, at most 40 recent pane lines, `HEAD`,
`git status --short`, recent `git log <base>..HEAD`, and the preceding
observation). Versioned code chooses the disposition. The Engine writes an
immutable request and evidence chain under `<run>/assessments/stall/` through
`stall.assessment.prepare`, `evaluate`, and `apply` (see
[engine-operations.md](engine-operations.md#typesafe-stall-assessment-operations)),
and appends each result to `## Stall evidence` before acting on it.

The TypeSafe credential is read only from Bun secrets using service
`com.wyattjoh.coordinate-implementation` and name `typesafe-api-key`. Never put
it in RESUME.md, JSON input, a prompt, a process argument, an artifact, or a
log.

## Dispositions

- `wait`: no worker change.
- `reprompt`: the Engine sends a code-owned prompt; TypeSafe never writes it.
- `retry-worker`: the Engine relaunches from the exact persisted binding
  through `infrastructure.retry.record`; exhaustion parks only that ticket.
- `pause`: the worker is left unchanged and the Engine opens a `stall_pause`
  escalation for that ticket.

A provider, credential, network, rate-limit, malformed-output, stale-evidence,
path, or binding failure also pauses: the Engine records the failed attempt
and opens a `stall_pause` escalation. It never normalizes invalid
probabilities, retries a provider automatically, or falls back to anyone's own
semantic judgment.

## Answer a `stall_pause`

Read the named pane and the evidence, then answer with the exact prompt the
Engine should deliver to the implementor, or ask the user when the evidence
does not settle it. The answer is delivered to the parked implementor; it
never rewrites the assessment's disposition.
