---
name: coordinate-implementation
description: Orchestrates a multi-ticket implementation run through a detached workflow runtime. Points at a `.scratch/<slug>/` folder holding a spec and numbered issues, prepares the run, then starts an Engine in its own Herdr tab that runs dependency-ready tickets in parallel, reviews each result on two axes, loops fixes back, and lands each ticket on the integration branch. The coordinator supervises through bounded waits and answers escalations. Repository-specific commands and safety constraints are discovered from project instructions and CI rather than assumed. Scheduling mode and validated Coordinator, Implementor, and Reviewer role records survive resumes and mid-run changes in RESUME.md. Triggers on "/coordinate-implementation", "implement the tickets in", "orchestrate the run", "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>] [--base <branch>] [--coordinator '<harness> <model> <effort>'] [--implementor '<harness> <model> <effort>'] [--reviewer '<harness> <model> <effort>'] [--serial | --parallel <N>] [--stall-interval <minutes>]"
compatibility: Requires macOS or Linux, Git, Bun, flock, Herdr 0.9.1 or later with the machine-readable event and snapshot API, Matt Pocock's implement skill, at least one supported harness (Pi or Claude Code), and a TypeSafe API key stored in Bun secrets.
disable-model-invocation: true
effort: low
---

# Coordinate an implementation run

You are the **coordinator**. You never implement a ticket yourself, and you no
longer drive tickets step by step. You prepare the run, start a detached
**Engine** that executes the run's workflow script, then supervise it through
bounded waits and answer the escalations it raises. The Engine launches and
prompts every implementor and reviewer, runs stall checks and gates, reads
agent reports from files, drives fix rounds, and lands tickets. Your context
limits, compaction, and restarts never interrupt ticket progress. The design
is recorded in
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

- `bun $SKILL_DIR/scripts/coordinate.ts` is the JSON helper. You call it for
  setup (`preflight`, `roles.discover`, `role.validate`, `worktree.preflight`,
  `review.policy.prepare`, `snapshot.accept`, `snapshot.check`), for
  `run.finalize`, and for explicitly authorized recovery. The Engine calls
  every other operation. Contract: [helper-cli.md](references/helper-cli.md).
- `bun $SKILL_DIR/scripts/runtime.ts` starts, waits on, answers, inspects, and
  stops the Engine. Contract: [runtime-cli.md](references/runtime-cli.md).

Arguments: `$ARGUMENTS`

- A run folder (`.scratch/<slug>`) starts or continues a run.
- `resume .scratch/<slug>` is the form a restarted or replacement session
  receives; do the **Resume** steps first.
- `--base <branch>` names the integration branch workers branch from and the
  Engine fast-forwards. Default `main`. Recorded as `Base:` in RESUME.md on
  first run; later invocations read it from there.
- `Branch template:` in RESUME.md records the repository's branch naming rule.
  Resolve it from repository instructions on first run, or use
  `<prefix>-NN-<slug>` when the repository has no rule.
- `--coordinator`, `--implementor`, and `--reviewer` each accept one quoted
  `'<harness> <model> <effort>'` triple. Harness is exactly `claude` or `pi`.
  Validate every supplied triple with the helper's `role.validate` operation.
  Never infer a harness from a model and never substitute a nearby model or
  effort after validation fails.
- `--serial` records `Mode: serial` and `Parallel cap: 1`. `--parallel <N>`
  requires a positive integer, records `Mode: parallel` and that maximum active
  implementor count, and is required for a first parallel run. Reject both flags
  together and reject a first run with neither. On resume with neither flag,
  preserve both recorded values. An explicit flag on resume is a preference
  change: write and log it before starting the Engine. A lower cap drains
  existing implementors without terminating them; a higher cap applies on the
  Engine's next scheduling pass.
- `--stall-interval <minutes>` records `Stall interval: <N>m`, an integer from
  2 to 60. A first run without the flag records `10m`. It is the period of the
  Engine's per-ticket stall timer. On resume the file wins unless the flag is
  present; an explicit flag or a stated preference is written and logged in
  `## Decisions`.

Before presenting role choices, call `roles.discover`. Offer only harnesses
reported as available, Pi models from its installed catalog, Claude Code's
`fable`, `opus`, and `sonnet` aliases plus custom model input, and the exact
efforts reported for the selected harness.

Collect every missing startup value in one structured interaction before
creating state or starting the Engine. The interaction covers the run folder,
base branch, scheduling mode or parallel cap when needed, and complete
Coordinator, Implementor, and Reviewer triples. Offer a current-session
Coordinator triple only when its harness, model, and effort are known. Validate
all three resolved records through `role.validate`, then persist all three in
RESUME.md before any launch. If the user explicitly supplies every value, do
not ask again.

Compare the selected or persisted Coordinator record with the invoking session.
An exact match keeps the current pane and initializes or resumes its ownership.
Herdr 0.9.1 cannot support a live coordinator replacement, so any harness,
model, or effort mismatch stops before state mutation. Ask the user to start a
matching coordinator session, then invoke or resume the run there. Never rewrite
the Coordinator record to make the invoking pane appear to match it. Recovery
rules are in [handoff.md](references/handoff.md).

Everywhere below, `<base>` means that branch. The main checkout is never
`<base>` unless `<base>` is `main`.

## Run folder contract

```
.scratch/<slug>/
  snapshot.json      # normalized source metadata, stable references, and ticket graph
  spec.md            # the agreed design; review axis 2 reads it
  issues/NN-*.md     # one ticket per file, `Blocked by:` + `Status:` lines, checkboxes
  run.ts                    # the workflow script the Engine executes; from references/run-template.ts
  briefs/common.md          # resolved repository contract; create from references/common-brief.md if absent
  briefs/fixes-NN-round-R.md # consolidated actionable findings for one fix round
  reviews/                  # immutable gate, self-review, Standards, and Spec evidence
  assessments/stall/        # immutable bounded TypeSafe request/evidence chains
  escalations/              # write-once escalation records and their answers
  steps/                    # write-once results of custom workflow steps
  events.ndjson             # the Engine's append-only event log
  RESUME.md                 # the ONLY mutable coordination state; format: references/resume-format.md
  SUMMARY.md                # deterministic local terminal summary written by run.finalize
$XDG_STATE_HOME/coordinate-implementation/
  runs/<run-id>.json        # helper-written global run summary and heartbeat (below)
  agreements/<repo-id>.json # helper-written cross-run agreements for one repository
```

Ticket readiness comes from the accepted dependency graph. A ticket is
unblocked only when every listed blocker has status `landed`. The Engine
schedules the frontier from the persisted mode and parallel cap. Only
implementors consume capacity; temporary reviewers do not. Do not serialize
parallel mode merely because two tickets might touch nearby code.

## Preferences

Which harness, model, and effort each role runs are **recorded state**, not
conversational memory. The canonical format, installed-harness discovery, and
validation rules are in [resume-format.md](references/resume-format.md). The
rules for keeping the record true:

- **The write is the acknowledgement.** A preference the user states and you
  have not yet written to RESUME.md does not exist. Write the file _before_
  you reply, then reply. This is not negotiable: the alternative is a
  preference that survives only as long as your context does.
- **Resolve once, persist the resolution.** You have the conversation; a
  successor does not. Write the explicitly selected and validated `harness`,
  `model`, and `effort` exactly as resolved. Never infer a harness from a model,
  make a later reader re-derive a field, or substitute another harness, model,
  or effort.
- **On resume, an explicit flag wins and is written back.** `--implementor`,
  `--reviewer`, `--serial`, `--parallel <N>`, or `--stall-interval <minutes>`
  passed at resume is a preference change: validate it, write it, and log it.
  `--coordinator` must match the invoking replacement session; live
  coordinator changes are unsupported. `--base` is the exception and the file
  wins; resume-format.md says why.
- **A session binds its record at launch.** The run-wide `Implementor:` and
  `Reviewer:` records govern future launches only. The Engine reads them from
  RESUME.md before each step. A ticket already running keeps its implementor
  record in the table row for its whole life, and every reviewer launch
  records the Reviewer default it bound. A Coordinator change requires the
  prior process to end and the replacement invocation to already use the
  selected record; it never becomes a state-only rewrite.
- **Log every change.** Append a dated line to `## Decisions` with the reason.
- **Re-read RESUME.md whenever `wait` returns**, so a hand edit is honored and
  you never overwrite one blindly.
- **Never bake a preference value into `run.ts`.** The workflow script reads
  tickets from the accepted snapshot and roles from RESUME.md.

## Several coordinators on one repo

Each run has a unique `Prefix:` (for example `dcs`) that names its worker
sessions `<prefix>-NN`, its Engine tab `engine <prefix>`, and its coordinator
pane label `coordinator <prefix>`. The coordinator's own Herdr tab is always
labelled `coordinator`: on start and on resume, run
`herdr tab rename "$HERDR_TAB_ID" "coordinator"` before anything else. Identify
yourself from the `HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`
environment variables injected into every managed pane, never by inspecting
`herdr pane list` for the focused pane: focus can belong to the user or another
client and can move at any time.

Cross-run discovery uses machine-local global run files under
`$XDG_STATE_HOME/coordinate-implementation/runs/` (default
`~/.local/state/...`). The helper rewrites a run's file atomically after every
RESUME.md mutation, and the Engine mirrors its lease there. Never write these
files yourself. The layout, versioned schemas, and reader protocol are in
[registry.md](references/registry.md). The old `.scratch/coordinators.md`
registry is retired: never read or update it, and leave any existing copy for
the user to delete.

- On start or resume: read the run files whose `repo.common_dir` matches this
  repository. Refuse to start if another run id records the same `prefix` with
  a heartbeat newer than twice its stall interval. Warn the user when two runs
  on the same base touch the same ticket files or implementation areas, then
  continue.
- Cross-run merge order and shared-file assignments live in the repository's
  agreements file, written only through `agreements.update` by its owner run.

Runs that share a `<base>` land through one dedicated base checkout. Every
landing, from any run or from `land-local`, holds the shared
`<git-common-dir>/land-local.lock` only for the ancestor check and
`git merge --ff-only`; a ticket whose branch is no longer based on `<base>`
bounces back to its implementor to rebase. Runs on different repos need
nothing beyond their own Herdr workspace.

## Start a run

Rename your tab to `coordinator` and label your pane `coordinator <prefix>`
(see above), then prepare the run in this order. Nothing launches until the
Engine starts in the last step.

1. **Preflight.** Invoke the helper's `preflight` operation with
   `state_path: null` (the existing RESUME.md on resume). Stop on any nonzero
   exit or `ok: false`; preflight reports every problem and never mutates
   state.
2. **Collect and validate** the startup values and role triples as described
   above, then create the schema-2 RESUME.md from
   [resume-format.md](references/resume-format.md) with `Base:`, `Base sha:`,
   `Mode:`, `Parallel cap:`, `Stall interval:`, `Branch template:`, all three
   role records, and coordinator ownership.
3. **Repository policy.** Resolve the complete worktree, branch, setup,
   cleanup, remote, and commit policy from repository instructions as
   described in [session-launch.md](references/session-launch.md). Require
   `worktree.preflight` to pass, then call it again with `state_path` so the
   helper persists the `## Repository policy` record, including the one
   authorized remote synchronization argv, or null for local-only.
4. **Common brief.** Resolve `<run>/briefs/common.md` from
   [common-brief.md](references/common-brief.md), repository instructions,
   and CI. No placeholder may remain.
5. **Review policy.** Persist exact gate argv arrays and resolved safety
   constraints with `review.policy.prepare`. Never infer a command from the
   detected toolchain.
6. **Accept the snapshot.** Materialize `snapshot.json`, the agreed
   specification, and every numbered ticket as defined in
   [normalized-snapshot.md](references/normalized-snapshot.md), then call
   `snapshot.accept`. For a non-local source, ask once for `none`, `final`, or
   `live` writeback and pass the repository's authoritative remote-write
   policy. A local source records `none` without a remote-write prompt.
7. **Write the workflow script.** Copy
   [run-template.ts](references/run-template.ts) to `<run>/run.ts` and replace
   every placeholder it lists: the absolute skill path, the recorded base
   checkout, the Pi implement skill path (delete that line for Claude
   implementors), and the authoritative project remote-write policy. Keep the default
   `standardTicket` pipeline unless the user asks for a different one; a
   custom script must stay deterministic given its step results.
8. **Start the Engine** with
   `bun $SKILL_DIR/scripts/runtime.ts start --run .scratch/<slug> --script .scratch/<slug>/run.ts`.
   It opens tab `engine <prefix>` and returns once the Engine holds its lease.

## Supervise the Engine

Loop on `runtime.ts wait --run .scratch/<slug>` until the run finishes. Omit
`--cursor`: the persisted Event Cursor survives compaction and restarts. Act on
the result, then call `wait` again. The complete result shape, commands, and
escalation table are in [runtime-cli.md](references/runtime-cli.md).

- `reason: "budget"`: nothing needs you. Report progress briefly when useful.
- `reason: "engine"`: `engine.liveness` is `stale`, `released`, or `none`. Run
  `start` again with the same script; it reconciles from RESUME.md and
  evidence, and nothing that already happened repeats. For
  `engine.unresponsive`, run `stop --force`, then `start`.
- `reason: "attention"`: handle every `attention` event and every entry in
  `open_escalations`. An `engine.failed` event carries its issue: report it
  faithfully, fix the cause with the user, then `start` again.
  `engine.completed` ends the loop (see [Finish the run](#finish-the-run)).

Never poll with sleeps, cron tools, scheduled prompts, background shells, or a
native harness task manager. `wait` is the only wait. Never launch, prompt, or
close an implementor or reviewer pane, run a gate, or land a ticket yourself
while the Engine runs.

### Answer escalations

An escalation parks only its ticket; every other ticket keeps running. Answer
each one with `runtime.ts answer --id <id> --text "<decision>"`. Answers are
write-once and the Engine delivers them to the parked ticket.

- `question`: an implementor wrote a `TICKET BLOCKED` question. Answer it
  yourself when `spec.md` or the tickets settle it, citing the source.
  Otherwise ask the user and answer with `--by user`. Never invent product
  intent.
- `scope`, `retry_exhausted`: ask the user and answer with `--by user`.
- `snapshot_changed`: report every changed input. Only after the user
  explicitly accepts the new revision, call `snapshot.accept`, then answer with
  `--by user`.
- `review_churn`: read the ticket's findings. Review fixes are pre-authorized
  regardless of round, so answer to continue unless the user decides
  otherwise.
- `stall_pause`, `report_missing`: read the named pane, then answer with what
  the Engine should tell the implementor, or ask the user when the evidence
  does not settle it. [stall-check.md](references/stall-check.md) describes
  the stall seam.

### Mid-run changes

Write a stated preference to RESUME.md and log it before replying; the Engine
reads it before its next step. A changed `run.ts` makes `start` fail with
`engine.script_changed` until you pass `--accept-script <sha256>` for the
reviewed new script.

## Finish the run

Before it exits, the Engine calls `run.finalize` with empty closures and emits
`run.finalized` with the returned `status`, `landed`, `blocked`, and `runnable`
tickets, followed by `engine.completed`. `completed` means `SUMMARY.md` exists.
`waiting` (a blocked empty frontier) is never success and is an attention
event. For each blocked ticket, either resolve the cause and run `start` again
(tickets that failed inside the Engine are retried on the next start), or close
it: only from an explicit user decision naming each blocked or
dependency-blocked ticket and reason, call `run.finalize` yourself with those
closures and `user_authorized: true`. The Engine has released its lease by
then, so the helper accepts the call. The operation moves preserved runtime
provenance to `## Closed ticket runtimes`, writes `## Run outcome`, and writes
`SUMMARY.md` only when every ticket is `landed` or `closed`. The summary
includes landed, blocked, and closed tickets, role provenance, review evidence,
retained branches, and pending tracker action. For `final` or `live`, delegate
the returned action to the persisted Matt tracker workflow only when current
project authority allows it. `none` performs no writeback. Local completion and
its summary are always recorded even when tracker action is pending or
forbidden. Report the outcome from `SUMMARY.md`.

## What the Engine does

The default `standardTicket` pipeline implements, then repeats rebase, gates,
self-review, both external reviews, and fixes until the ticket lands. You do
not perform these steps, but you must understand them to answer escalations
and recover. Details: [session-launch.md](references/session-launch.md),
[review-and-land.md](references/review-and-land.md),
[stall-check.md](references/stall-check.md).

- It creates each worktree through `worktree.prepare`, launches the
  implementor through `implementor.launch.prepare` and
  `implementor.launch.record`, and retries infrastructure failures three times
  with the exact bound role before escalating `retry_exhausted`.
- Before gates, `landing.rebase.check` decides whether the implementor must
  rebase its own branch in its own worktree; `landing.rebase.record` records
  the new integration cycle. Every gate reruns after a rebase; both reviews
  rerun only when the ticket's patch identity changed.
- Standards and Spec reviews always run as fresh independent Herdr sessions
  under the persisted Reviewer role, after the harness-appropriate
  implementor self-review. A finding always means FAIL and returns one
  consolidated fix request to the same implementor.
- `landing.complete` fast-forwards `<base>` under the shared land lock, writes
  landed evidence, cleans up the worktree without force, and retains the
  branch.

Session markers the implementor prints: `TICKET DONE NN`,
`TICKET BLOCKED NN: <question>`, `FIXES DONE NN`, `REBASE DONE NN`. Herdr agent
status and the report files are the wake authority, not marker text.

## Manual recovery

Recovery operations exist for explicitly authorized repairs the Engine cannot
decide: `implementor.launch.recover`, `implementor.runtime.migrate`,
`implementor.runtime.migration.recover`, `review.attempt.supersede`,
`gate.rerun.record`, and `review.escalation.authorize`. Use one only with
explicit user authority, only after `runtime.ts stop` confirms the Engine
released its lease, and exactly as [helper-cli.md](references/helper-cli.md)
specifies. Then `start` the Engine again.

A crashed worker restarts in the same worktree **with the record bound in its
table row**. Never read the run-wide `Implementor:` for it and never
substitute a harness, model, effort, skill, branch, or worktree. A crash is
evidence about a process, not about a model. One ticket's difficulty is not a
judgement about the remaining tickets, so never rewrite the run-wide
`Implementor:` to recover one ticket.

## Coordinator continuity

Automatic coordinator handoff is disabled because Herdr 0.9.1 does not expose
normalized model context utilization. Record `Coordinator.handoff: disabled`
and `Coordinator.threshold: unavailable` in RESUME.md. Continue through the
active harness's normal context compaction without replacing the coordinator.
Never parse rendered pane output to estimate context use.

The Engine keeps running while the coordinator compacts or exits. If the
coordinator process exits or cannot recover, leave its pane and durable state
intact until the user starts a replacement with `resume .scratch/<slug>`. The
replacement follows the Resume procedure and claims ownership through the
existing coordinator compare-and-swap operations. It must not invoke any
`coordinator.handoff.*` operation. Full recovery rules:
[handoff.md](references/handoff.md).

## Resume

When invoked as `resume .scratch/<slug>` for a restart or replacement:

1. Run the helper `preflight` operation with the run's `RESUME.md` as
   `state_path`, then invoke `snapshot.check`. A changed snapshot reports its
   changed inputs and waits for the user's explicit acceptance flow. Then
   validate the remaining fields against
   [resume-format.md](references/resume-format.md). Missing, malformed, or
   unsupported schema versions stop the resume without migration. Any other
   mismatch also stops with an explanation; nothing is guessed.
   If `--coordinator` differs from the persisted record or the invoking
   session, stop and ask the user to start a matching replacement session.
   Differing `--implementor`, `--reviewer`, `--serial`, `--parallel <N>`, or
   `--stall-interval <minutes>` values are preference changes: validate them,
   write them, and log them in `## Decisions`.
2. Rename your own tab to `coordinator` and label your own pane
   `coordinator <prefix>`, using `$HERDR_TAB_ID` and `$HERDR_PANE_ID`.
3. Check the global run files for a conflicting live prefix as described in
   [Several coordinators on one repo](#several-coordinators-on-one-repo).
4. If this is a replacement coordinator, verify the previous process is no
   longer active, then use the normal coordinator claim and readiness
   operations. Do not invoke `coordinator.handoff.*`.
5. Run `runtime.ts status`. Then run `start` with the recorded `run.ts`: it
   attaches to a live Engine or starts a new generation that reconciles from
   RESUME.md without relaunching live workers.
6. Report the state in a short list and continue the supervision loop.

## Rules that are not negotiable

- Preflight must succeed before creating or mutating RESUME.md. Never infer
  context use from rendered terminal text or invoke automatic handoff.
- The Engine schedules, reviews, and lands only against an accepted,
  unchanged snapshot. Changed input hashes pause affected work until explicit
  `snapshot.accept` records the revision and decision.
- Exactly one Engine drives a run. Never start a second one, and never mutate
  ticket state through the helper while an Engine holds the lease.
- Persist and obey the tracker writeback mode. Delegate `final` and `live`
  updates to the configured Matt tracker workflow only when current project
  authority permits them. `none` never writes. Always preserve the local final
  summary and report pending or forbidden tracker action. Never add
  tracker-specific commands to the coordinator.
- A preference the user states and you have not written to RESUME.md does not
  exist. Write before you reply.
- Never substitute a default model, effort, harness, worktree tool, or required
  skill to keep a run moving. A record that will not launch stops the ticket
  and is reported.
- Repository commit policy wins. When it is silent, multiple commits are
  allowed and fix rounds append commits.
- Every commit passes the repository's required gates before review. Resolve
  exact argv arrays and safety constraints from repository instructions and CI,
  then persist them with `review.policy.prepare` before starting the Engine.
- Answer a `TICKET BLOCKED` question from the spec and tickets first; ask the
  user when they do not settle it. Scope decisions always belong to the user.
- Never push or write to forge issues. The only permitted remote write is a
  persisted `final` or `live` update through the configured Matt tracker
  workflow when authoritative project policy allows it. All other remote
  writes remain forbidden.
- Enforce every project-specific safety constraint recorded in the shared
  brief. Do not invent restrictions that the repository does not require.
- Rebase conflicts belong to the implementor, never the coordinator. The
  implementor rebases its own branch in its own worktree and resolves
  conflicts there; never rebase, merge, or edit a ticket branch or the base
  checkout yourself.
- Report outcomes faithfully: a red gate is reported as red with its output.
