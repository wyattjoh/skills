---
name: coordinate-implementation
description: Orchestrates a multi-ticket implementation run through a detached workflow runtime. Points at a `.scratch/<slug>/` folder holding a spec and numbered issues, prepares the run, then starts an Engine in its own Herdr tab that runs dependency-ready tickets in parallel, reviews each result on two axes, loops fixes back, and lands each ticket on the integration branch. The coordinator supervises through bounded waits and answers escalations. Repository-specific commands and safety constraints are discovered from project instructions and CI rather than assumed. Scheduling mode and validated Coordinator, Implementor, and Reviewer role records survive resumes and mid-run changes in RESUME.md. Triggers on "/coordinate-implementation", "implement the tickets in", "orchestrate the run", "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>] [--base <branch>] [--coordinator '<harness> <model> <effort>'] [--implementor '<harness> <model> <effort>'] [--reviewer '<harness> <model> <effort>'] [--serial | --parallel <N>] [--stall-interval <minutes>]"
compatibility: Requires macOS or Linux, Git, Bun, flock, Herdr 0.9.1 or later with the machine-readable event and snapshot API, Matt Pocock's implement skill, at least one supported harness (Pi or Claude Code), and a TypeSafe API key stored in Bun secrets.
disable-model-invocation: true
effort: low
---

# Coordinate an implementation run

You are the **coordinator**. You never implement a ticket yourself, and you do
not drive tickets step by step. You prepare the run, start a detached
**Engine** that executes the run's workflow script, then supervise it through
bounded waits and answer the escalations it raises. The Engine launches and
prompts every implementor and reviewer, runs stall checks and gates, reads
agent reports from files, drives fix rounds, and lands tickets, so your
context limits, compaction, and restarts never interrupt ticket progress. The
design is recorded in
[0003-detached-workflow-runtime.md](docs/adr/0003-detached-workflow-runtime.md).

The baseline environment is macOS or Linux with Git, Bun, `flock`, Herdr 0.9.1
or later, Matt Pocock's `implement` skill, at least one supported harness (Pi
or Claude Code), and a TypeSafe API key in Bun secrets under service
`com.wyattjoh.coordinate-implementation` and name `typesafe-api-key`. Herdr
must expose the machine-readable `events.subscribe` and `session.snapshot`
methods. Coordination must run inside a Herdr-managed pane with
`HERDR_ENV=1`. Load the `herdr` skill in the same invocation using the active
harness's supported skill syntax so the coordinator can identify and control
its own pane.

Two Bun entry points do the mechanical work:

- `bun $SKILL_DIR/scripts/coordinate.ts` is the JSON helper for setup,
  coordinator ownership, `run.finalize`, and explicitly authorized recovery.
  Contract: [helper-cli.md](references/helper-cli.md).
- `bun $SKILL_DIR/scripts/runtime.ts` starts, waits on, answers, inspects, and
  stops the Engine. Contract: [runtime-cli.md](references/runtime-cli.md).

## Arguments

`$ARGUMENTS`

- A run folder (`.scratch/<slug>`) starts or continues a run.
- `resume .scratch/<slug>` is the form a restarted or replacement session
  receives; do the **Resume** steps first.
- `--base <branch>` names the integration branch workers branch from and the
  Engine fast-forwards. Default `main`. Recorded as `Base:` on the first run;
  later invocations read it from RESUME.md, and the file wins over the flag.
  Everywhere below, `<base>` means that branch.
- `--coordinator`, `--implementor`, and `--reviewer` each accept one quoted
  `'<harness> <model> <effort>'` triple. Harness is exactly `claude` or `pi`.
- `--serial` records `Mode: serial` and `Parallel cap: 1`. `--parallel <N>`
  requires a positive integer and records `Mode: parallel` and that maximum
  active implementor count. Reject both flags together, and reject a first run
  with neither. A lower cap drains existing implementors without terminating
  them; a higher cap applies on the Engine's next scheduling pass.
- `--stall-interval <minutes>` records `Stall interval: <N>m`, an integer from
  2 to 60, default `10m`. It is the period of the Engine's per-ticket stall
  timer.

On resume, a flag other than `--base` and `--coordinator` is a preference
change: validate it, write it, and log it before starting the Engine. Without
flags, the recorded values stand.

`Branch template:` records the repository's branch naming rule. Resolve it
from repository instructions on the first run, or use `<prefix>-NN-<slug>` when
the repository has no rule.

## Roles and preferences

Which harness, model, and effort each role runs are **recorded state** in
RESUME.md, not conversational memory. The format, installed-harness discovery,
and validation rules are in [resume-format.md](references/resume-format.md).

- Before presenting role choices, call `roles.discover`. Offer only harnesses
  it reports as available, Pi models from the installed catalog, Claude Code's
  `fable`, `opus`, and `sonnet` aliases plus custom model input, and the exact
  efforts reported for the selected harness.
- Collect every missing startup value (run folder, base branch, scheduling
  mode or cap, and all three role triples) in one structured interaction before
  creating state. Offer a current-session Coordinator triple only when its
  harness, model, and effort are known. If the user supplied every value, do
  not ask again.
- Validate every triple with `role.validate` and write it exactly as resolved.
  Never infer a harness from a model, and never substitute a nearby harness,
  model, or effort, including after validation fails.
- **The write is the acknowledgement.** A preference the user states and you
  have not yet written to RESUME.md does not exist. Write the file, append a
  dated line with the reason to `## Decisions`, then reply.
- Re-read RESUME.md whenever `wait` returns, so a hand edit is honored and
  never overwritten blindly.
- `Implementor:` and `Reviewer:` govern future launches only; the Engine reads
  them before each step. A running ticket keeps the implementor record bound
  in its table row for its whole life, and every reviewer launch records the
  Reviewer default it bound.
- The Coordinator record must match the invoking session exactly. Herdr 0.9.1
  cannot replace a live coordinator, so any harness, model, or effort mismatch
  stops before state mutation: ask the user to start a matching session and
  invoke or resume the run there. Never rewrite the Coordinator record to make
  the invoking pane appear to match it.
- Never bake a preference value into `run.ts`.

## Run folder contract

```
.scratch/<slug>/
  snapshot.json              # normalized source metadata, stable references, and ticket graph
  spec.md                    # the agreed design; review axis 2 reads it
  issues/NN-*.md             # one ticket per file, `Blocked by:` + `Status:` lines, checkboxes
  run.ts                     # the workflow script the Engine executes; from references/run-template.ts
  briefs/common.md           # resolved repository contract; create from references/common-brief.md if absent
  briefs/fixes-NN-round-R.md # consolidated actionable findings for one fix round
  reviews/                   # immutable gate, self-review, Standards, and Spec evidence
  assessments/stall/         # immutable bounded TypeSafe request/evidence chains
  escalations/               # write-once escalation records and their answers
  steps/                     # write-once results of custom workflow steps
  events.ndjson              # the Engine's append-only event log
  RESUME.md                  # the ONLY mutable coordination state; format: references/resume-format.md
  SUMMARY.md                 # deterministic local terminal summary written by run.finalize
$XDG_STATE_HOME/coordinate-implementation/
  runs/<run-id>.json         # helper-written global run summary and heartbeat
  agreements/<repo-id>.json  # helper-written cross-run agreements for one repository
```

A ticket is unblocked only when every blocker in the accepted dependency graph
has status `landed`. The Engine schedules the frontier from the persisted mode
and cap. Only implementors consume capacity; temporary reviewers do not. Do not
serialize parallel mode merely because two tickets might touch nearby code.

## Several coordinators on one repo

Each run has a unique `Prefix:` (for example `dcs`) that names its worker
sessions `<prefix>-NN`, its Engine tab `engine <prefix>`, and its coordinator
pane label `coordinator <prefix>`. On start and on resume, first run
`herdr tab rename "$HERDR_TAB_ID" "coordinator"` and label your pane
`coordinator <prefix>`. Identify yourself only from the `HERDR_PANE_ID`,
`HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` environment variables, never from the
focused pane in `herdr pane list`: focus can move at any time.

Cross-run discovery uses the global run files, which only the helper and
Engine write ([registry.md](references/registry.md)). On start or resume, read
the run files whose `repo.common_dir` matches this repository. Refuse to start
if another run id records the same `prefix` with a heartbeat newer than twice
its stall interval. Warn the user when two runs on the same base touch the same
ticket files or implementation areas, then continue. Cross-run merge order and
shared-file assignments live in the repository's agreements file, written only
through `agreements.update` by its owner run.

Every landing, from any run or from `land-local`, holds the shared
`<git-common-dir>/land-local.lock` only for the ancestor check and
`git merge --ff-only`.

## Start a run

Rename your tab and label your pane (above), then prepare the run in this
order. Nothing launches until the Engine starts in the last step.

1. **Preflight.** Invoke `preflight` with `state_path: null`. Stop on any
   nonzero exit or `ok: false`; preflight reports every problem and never
   mutates state.
2. **Collect and validate** the startup values and role triples, then create
   the schema-2 RESUME.md from [resume-format.md](references/resume-format.md)
   with `Base:`, `Base sha:`, `Mode:`, `Parallel cap:`, `Stall interval:`,
   `Branch template:`, all three role records, and coordinator ownership. Leave
   out every helper-managed section; the operations below create them.
3. **Repository policy.** Resolve the worktree, branch, setup, cleanup,
   remote, and commit policy as described in
   [session-launch.md](references/session-launch.md). Require
   `worktree.preflight` to pass, then call it again with `state_path` to
   persist `## Repository policy`.
4. **Common brief.** Resolve `<run>/briefs/common.md` from
   [common-brief.md](references/common-brief.md), repository instructions,
   and CI. No placeholder may remain.
5. **Review policy.** Persist exact gate argv arrays and safety constraints
   with `review.policy.prepare`, as described in
   [review-and-land.md](references/review-and-land.md). Never infer a command
   from the detected toolchain.
6. **Accept the snapshot.** Materialize `snapshot.json`, the agreed
   specification, and every numbered ticket as defined in
   [normalized-snapshot.md](references/normalized-snapshot.md), then call
   `snapshot.accept`. For a non-local source, ask once for `none`, `final`, or
   `live` writeback and pass the repository's authoritative remote-write
   policy. A local source records `none` without a prompt.
7. **Write the workflow script.** Copy
   [run-template.ts](references/run-template.ts) to `<run>/run.ts` and replace
   every placeholder it lists. Keep the default `standardTicket` pipeline
   unless the user asks for a different one; a custom script must stay
   deterministic given its step results.
8. **Start the Engine** with
   `bun $SKILL_DIR/scripts/runtime.ts start --run .scratch/<slug> --script .scratch/<slug>/run.ts`.
   It opens tab `engine <prefix>` and returns once the Engine holds its lease.

## Supervise the Engine

Loop on `runtime.ts wait --run .scratch/<slug>` until the run finishes. Omit
`--cursor`: the persisted Event Cursor survives compaction and restarts. Act on
the result, then call `wait` again.

- `reason: "budget"`: nothing needs you. Report progress briefly when useful.
- `reason: "engine"`: `engine.liveness` is `stale`, `released`, or `none`. Run
  `start` again with the same script; it reconciles from RESUME.md and
  evidence, and nothing that already happened repeats. For
  `engine.unresponsive`, run `stop --force`, then `start`.
- `reason: "attention"`: handle every `attention` event and every entry in
  `open_escalations`. Report an `engine.failed` event faithfully, fix the cause
  with the user, then `start` again. `engine.completed` ends the loop.

`wait` is the only wait. Never poll with sleeps, cron tools, scheduled prompts,
background shells, or a native harness task manager. While the Engine runs,
never launch, prompt, or close an implementor or reviewer pane, run a gate, or
land a ticket yourself.

A changed `run.ts` makes `start` fail with `engine.script_changed` until you
pass `--accept-script <sha256>` for the reviewed new script.

### Answer escalations

An escalation parks only its ticket; every other ticket keeps running. Answer
each one with `runtime.ts answer --id <id> --text "<decision>"`, adding
`--by user` when the text is the user's decision. Answers are write-once.

- `question`: an implementor's `TICKET BLOCKED` question. Answer it yourself
  when `spec.md` or the tickets settle it, citing the source. Otherwise ask the
  user. Never invent product intent, and scope decisions always belong to the
  user.
- `retry_exhausted`: ask the user. The ticket stays blocked until its cause is
  fixed and the Engine is started again.
- `snapshot_changed`: report every changed input. Only after the user
  explicitly accepts the new revision, call `snapshot.accept`, then answer.
- `stall_pause`: read the named pane, then answer with the exact prompt the
  Engine should deliver, or ask the user when the evidence does not settle it
  ([stall-check.md](references/stall-check.md)).
- `attention.review_churn` is an event, not an escalation. Review fixes are
  pre-authorized regardless of round, so keep waiting unless the user decides
  to stop the ticket.

## Finish the run

Before it exits, the Engine calls `run.finalize` and emits `run.finalized`
with the returned `status`, `landed`, `blocked`, and `runnable` tickets,
followed by `engine.completed`. `completed` means `SUMMARY.md` exists.
`waiting` (a blocked empty frontier) is never success. For each blocked ticket,
either resolve the cause and run `start` again, or close it: only from an
explicit user decision naming each blocked or dependency-blocked ticket and
reason, call `run.finalize` yourself with those closures and
`user_authorized: true`. `SUMMARY.md` is written only when every ticket is
`landed` or `closed`.

For `final` or `live` writeback, delegate the returned tracker action to the
persisted Matt tracker workflow only when current project authority allows it;
`none` performs no writeback. Local completion and its summary are always
recorded, even when tracker action is pending or forbidden. Report the outcome
from `SUMMARY.md`.

## What the Engine does

The default `standardTicket` pipeline implements, then repeats rebase, gates,
self-review, both external reviews, and fixes until the ticket lands. You need
this to answer escalations and recover; details are in
[session-launch.md](references/session-launch.md),
[review-and-land.md](references/review-and-land.md), and
[stall-check.md](references/stall-check.md).

- Infrastructure failures retry three times with the exact bound role before a
  `retry_exhausted` escalation.
- When `<base>` has moved, the implementor rebases its own branch in its own
  worktree. Every gate reruns after a rebase; both reviews rerun only when the
  ticket's patch identity changed.
- Standards and Spec reviews run as fresh Herdr sessions under the persisted
  Reviewer role, after the implementor's self-review. Any finding means FAIL
  and one consolidated fix request to the same implementor.
- Landing fast-forwards `<base>` under the land lock, cleans up the worktree
  without force, and retains the branch.

Implementors print `TICKET DONE NN`, `TICKET BLOCKED NN: <question>`,
`FIXES DONE NN`, and `REBASE DONE NN`. Herdr agent status and the report files
are the wake authority, not marker text.

## Manual recovery

The recovery operations in [helper-cli.md](references/helper-cli.md)
(`implementor.launch.recover`, `implementor.runtime.migrate`,
`implementor.runtime.migration.recover`, `review.attempt.supersede`, and
`gate.rerun.record`) exist for explicitly authorized repairs the Engine cannot
decide. Use one only with explicit user authority, only after `runtime.ts stop`
confirms the Engine released its lease, and exactly as documented. Then
`start` the Engine again.

A crashed worker restarts in the same worktree with the record bound in its
table row. Never read the run-wide `Implementor:` for it, and never substitute
a harness, model, effort, skill, branch, or worktree. A crash is evidence about
a process, not about a model, so never rewrite the run-wide `Implementor:` to
recover one ticket.

## Coordinator continuity

Herdr 0.9.1 does not expose normalized model context utilization, so there is
no automatic coordinator handoff. Continue through the active harness's normal
context compaction; never parse rendered pane output, titles, or token
metadata to estimate context use. Before a turn ends, answer every escalation
you already decided and persist every stated preference and decision.

The Engine keeps running while the coordinator compacts or exits. If the
coordinator process exits or cannot recover, leave its pane and durable state
intact until the user starts a replacement with `resume .scratch/<slug>`. The
coordinator generation and the Engine Lease are independent: a replacement
never claims or releases the Engine Lease, and never relaunches workers that
remain present in Herdr.

## Resume

When invoked as `resume .scratch/<slug>`:

1. Run `preflight` with the run's `RESUME.md` as `state_path`, then
   `snapshot.check`. A changed snapshot reports its changed inputs and waits
   for the user's explicit acceptance. Validate the remaining fields against
   [resume-format.md](references/resume-format.md); a missing, malformed, or
   unsupported schema, or any other mismatch, stops with an explanation and
   nothing is guessed. Apply the Coordinator match rule and any preference
   flags (see [Arguments](#arguments)).
2. Rename your tab and label your pane.
3. Check the global run files for a conflicting live prefix.
4. If this is a replacement, verify the previous coordinator process is no
   longer active, then take ownership with `coordinator.claim` followed by
   `coordinator.ready`. Do not close a live predecessor to make a claim
   succeed.
5. Run `runtime.ts status`, then `start` with the recorded `run.ts`: it
   attaches to a live Engine or starts a new generation that reconciles from
   RESUME.md without relaunching live workers.
6. Report the state in a short list and continue the supervision loop.

## Rules that are not negotiable

- Preflight must succeed before creating or mutating RESUME.md.
- The Engine schedules, reviews, and lands only against an accepted, unchanged
  snapshot. Changed input hashes pause affected work until explicit
  `snapshot.accept` records the revision and decision.
- Exactly one Engine drives a run. Never start a second one, and never mutate
  ticket state through the helper while an Engine holds the lease.
- Never substitute a default model, effort, harness, worktree tool, or required
  skill to keep a run moving. A record that will not launch stops the ticket
  and is reported.
- Repository commit policy wins. When it is silent, multiple commits are
  allowed and fix rounds append commits.
- Never push or write to forge issues. The only permitted remote write is a
  persisted `final` or `live` update through the configured Matt tracker
  workflow when authoritative project policy allows it. Never add
  tracker-specific commands to the coordinator.
- Enforce every project-specific safety constraint recorded in the shared
  brief. Do not invent restrictions that the repository does not require.
- Rebase conflicts belong to the implementor, never the coordinator. Never
  rebase, merge, or edit a ticket branch or the base checkout yourself.
- Report outcomes faithfully: a red gate is reported as red with its output.
