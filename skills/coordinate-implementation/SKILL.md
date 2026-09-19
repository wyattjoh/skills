---
name: coordinate-implementation
description: Orchestrates a multi-ticket implementation run. Points at a `.scratch/<slug>/` folder holding a spec and numbered issues, then runs dependency-ready tickets in parallel by default, reviews each result on two axes, loops fixes back, and fast-forwards the integration branch. Repository-specific commands and safety constraints are discovered from project instructions and CI rather than assumed. Scheduling mode and validated Coordinator, Implementor, and Reviewer role records survive resumes and mid-run changes in RESUME.md. Triggers on "/coordinate-implementation", "implement the tickets in", "orchestrate the run", "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>] [--base <branch>] [--coordinator '<harness> <model> <effort>'] [--implementor '<harness> <model> <effort>'] [--reviewer '<harness> <model> <effort>'] [--serial | --parallel <N>]"
compatibility: Requires macOS or Linux, Git, Bun, Herdr 0.9.1 or later with the machine-readable event and snapshot API, Matt Pocock's implement skill, and at least one supported harness (Pi or Claude Code).
disable-model-invocation: true
effort: low
---

# Coordinate an implementation run

You are the **orchestrator**. You never implement a ticket yourself. You run
one implementor session per ticket, start every dependency-ready ticket in
parallel by default, review each policy-compliant ticket branch, send fixes
back into the same session, and land it on the configured integration branch.

The baseline environment is macOS or Linux with Git, Bun, Herdr 0.9.1 or
later, Matt Pocock's `implement` skill, and at least one supported harness (Pi
or Claude Code). Herdr must expose the machine-readable `events.subscribe` and
`session.snapshot` methods. Coordination must run inside a Herdr-managed pane
with `HERDR_ENV=1`. Load the `herdr` skill in the same invocation using the
active harness's supported skill syntax so the coordinator can identify and
control its own pane.

Before creating or changing run state, invoke the versioned Bun helper's
`preflight` operation. On resume, pass the existing RESUME.md as `state_path`.
Stop on any nonzero exit or `ok: false`; preflight reports all detected
problems and never mutates state. The complete request and result contract is
[helper-cli.md](references/helper-cli.md).

After preflight, coordination starts only from the accepted normalized local
snapshot defined in
[normalized-snapshot.md](references/normalized-snapshot.md). Materialize
`snapshot.json`, the agreed specification, and every numbered ticket before
scheduling. Use `snapshot.accept` for the initial revision, then
`snapshot.check` before every scheduling pass and review. A result with
`scheduling_allowed: false` pauses new scheduling until the user explicitly
accepts and records the changed revision.

Arguments: `$ARGUMENTS`

- A run folder (`.scratch/<slug>`) starts or continues a run.
- `resume .scratch/<slug>` is the form a restarted or replacement session
  receives; do the **Resume** steps first.
- `--base <branch>` names the integration branch workers branch from and the
  coordinator fast-forwards. Default `main`. Recorded as `Base:` in RESUME.md
  on first run; later invocations read it from there.
- `Branch template:` in RESUME.md records the repository's branch naming rule.
  Resolve it from repository instructions on first run, or use
  `<prefix>-NN-<slug>` when the repository has no rule. Before creating any
  worktree, resolve the complete repository policy, require
  `worktree.preflight` to pass, then persist and apply it through
  `worktree.prepare` as described in [session-launch.md](references/session-launch.md).
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
  change: write and log it before scheduling more work. A lower cap drains
  existing implementors without terminating them; a higher cap applies on the
  next scheduling pass.

Before presenting role choices, call `roles.discover`. Offer only harnesses
reported as available, Pi models from its installed catalog, Claude Code's
`fable`, `opus`, and `sonnet` aliases plus custom model input, and the exact
efforts reported for the selected harness.

Collect every missing startup value in one structured interaction before
creating state or launching any session. The interaction covers the run folder,
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
  briefs/common.md          # resolved repository contract; create from references/common-brief.md if absent
  briefs/fixes-NN-round-R.md # consolidated actionable findings for one fix round
  reviews/                  # immutable gate, self-review, Standards, and Spec evidence
  RESUME.md                 # the ONLY mutable coordination state; format: references/resume-format.md
  SUMMARY.md                # deterministic local terminal summary written by run.finalize
.scratch/coordinators.md   # repo-wide run discovery registry (below)
```

Ticket readiness comes from the accepted dependency graph. A ticket is
unblocked only when every listed blocker has status `landed`. Before every
launch pass, call `scheduler.plan` with the persisted mode, parallel cap,
ticket states, and active runtimes. Launch its deterministic `launch_tickets`
order. Only runtimes whose role is `implementor` and state is `active` consume
capacity; temporary reviewers do not. Do not serialize parallel mode merely
because two tickets might touch nearby code. Their branches synchronize
against the latest `<base>` before review and landing.

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
  `--reviewer`, `--serial`, or `--parallel <N>` passed at resume is a preference
  change: validate it, write it, and log it. `--coordinator` must match the
  invoking replacement session; live coordinator changes are unsupported.
  `--base` is the exception and the file wins; resume-format.md says why.
- **A session binds its record at launch.** The run-wide `Implementor:` and
  `Reviewer:` records govern future launches only. A ticket already running
  keeps its implementor record in the table row for its whole life, and every
  reviewer launch records the Reviewer default it bound. A Coordinator change
  requires the prior process to end and the replacement invocation to already
  use the selected record; it never becomes a state-only rewrite.
- **Log every change.** Append a dated line to `## Decisions` with the reason.
- **Re-read RESUME.md at each progress tick**, so a hand edit is honored and
  you never overwrite one blindly.
- **Never bake a preference value into a scheduled prompt.** See
  [Progress loop](#progress-loop).

## Several coordinators on one repo

Each run has a unique `Prefix:` (for example `dcs`) that names its worker
sessions `<prefix>-NN`, its herdr tabs `claude <prefix> NN <slug>`, and its
coordinator pane label `coordinator <prefix>`. Render the run's
`Branch template:` from RESUME.md, then let `worktree.prepare` apply the
persisted repository policy. Always use the actual worktree path and branch
returned by the helper.
The coordinator's own herdr tab is always labelled `coordinator`: on start and
on resume, run `herdr tab rename "$HERDR_TAB_ID" "coordinator"` before anything
else. Identify yourself from the `HERDR_PANE_ID` / `HERDR_TAB_ID` /
`HERDR_WORKSPACE_ID` environment variables injected into every managed pane,
never by inspecting `herdr pane list` for the focused pane: focus can belong to
the user or another client and can move at any time.

`.scratch/coordinators.md` is the cross-run discovery registry. Its canonical
schema and ownership rules are in [registry.md](references/registry.md). Every
run owns exactly one row; only that run's current ready coordinator may change
or remove it. A downstream multi-run coordinator reads rows and each row's
schema-1 RESUME.md, but never edits either.

- On start or resume: read it; refuse to start if the prefix is already listed
  with a different live ready owner, otherwise add or update your own row.
  Warn the user when two runs on the same base touch the same ticket files or
  implementation areas, then continue.
- Update your row whenever a ticket starts, blocks, closes, or lands, after a
  coordinator replacement, and after `run.finalize` changes run status.
- Record `completed` before closing. Remove the row only when no downstream
  coordinator requires the completion tombstone or after it acknowledges the
  terminal state.

Runs that share a `<base>` land through one dedicated base checkout and
serialize by rebase-and-retry, no lock. The main checkout holds `main`;
non-main base checkouts follow the coordinator harness's native worktree
lifecycle: [session-launch.md](references/session-launch.md) and
[review-and-land.md](references/review-and-land.md). Runs on different repos
need nothing beyond their own herdr workspace.

## Core loop (standing instructions)

Before the first iteration, complete the read-only helper preflight described
in [helper-cli.md](references/helper-cli.md). Only after it succeeds, resolve
`<run>/briefs/common.md` from [common-brief.md](references/common-brief.md),
repository instructions, and CI. No placeholder may remain when a worker
launches. Create the schema-1 run state, persist exact gate argv arrays and
resolved safety constraints with `review.policy.prepare`, then accept the
normalized snapshot. Review policy preparation must precede every worker
launch; never infer a command from the detected toolchain.
For a non-local source, ask once for `none`, `final`, or `live` writeback and
pass the repository's authoritative remote-write policy. A local source records
`none` without a remote-write prompt. Rename your own tab to
`coordinator` and label your pane `coordinator <prefix>` (see above). Then
repeat until every ticket is landed or the user explicitly closes each
remaining blocked ticket:

1. **Schedule.** Invoke `snapshot.check` and stop this scheduling pass unless
   it returns `unchanged` with `scheduling_allowed: true`. Report every changed
   input. Read `Mode:`, `Parallel cap:`, the accepted dependency graph, ticket
   states, and active runtime records from RESUME.md. Verify `Base sha:` against
   the base checkout and update it if the branch moved. Call `scheduler.plan`
   and launch every returned ticket in order. Bind the current `Implementor:`
   record into each selected ticket's table row before starting it; that row,
   not the run-wide record, governs the ticket from then on. The required
   `implement` skill is fixed and explicitly loaded for both harnesses. Do not
   require it to appear in model discovery. Resolve repository worktree,
   branch, setup, cleanup, remote, and commit policy before creating the
   worktree. Persist the one authorized remote synchronization argv (or null
   for local-only) and never accept a caller-selected substitute. Require
   `worktree.preflight` to pass before state mutation, then
   call `worktree.prepare`, create the Herdr tab at the returned path, and call
   `implementor.launch.prepare`. Execute only its argument arrays and persist
   the observed outcome with `implementor.launch.record`. Exact procedure:
   [session-launch.md](references/session-launch.md).
2. **Wait.** Call `herdr.wait_any` once with every active worker,
   `coordinator: null`, and a bounded timeout. It subscribes before snapshotting.
   Persist refreshed pane ids from its complete worker snapshot. On `status` or
   `pane_exited`, act on the named runtime. On `timeout`, perform stall,
   snapshot-integrity, and base checks, run one scheduling pass, then issue
   another bounded wait. Do not create cron jobs, shell wait loops, background
   monitors, or harness-native tasks.
3. **Review** when wait-any returns an idle or done implementor. Invoke
   `snapshot.check` first and do not begin review or landing against a changed
   revision. If several tickets become ready together, process them one at a
   time in dependency order. Sync
   the chosen branch to the latest `<base>` before its final gates and review,
   then require the recorded repository commit policy, green recorded gates,
   the harness-appropriate implementor self-review, and fresh independent Herdr
   sessions for Standards and Spec. Claim the serialized finalization slot and
   perform policy-driven synchronization with `landing.synchronize`; use its
   returned full-SHA `review_range` for gates and both review axes. Capture and
   persist each complete report before closing its pane. Procedure:
   [review-and-land.md](references/review-and-land.md).
4. **Fix loop.** Finalize both axes with `review.round.finalize`. Send its one
   consolidated request, containing every actionable finding, to the same worker
   session. Apply the recorded fix-commit policy, which defaults to appending a
   commit when repository instructions are silent, then print `FIXES DONE NN`.
   Include that runtime in the next wait-any call. When it returns terminal,
   restart the pipeline from all recorded gates; every fix round receives new
   self-review and fresh Standards and Spec sessions. If a failed gate passes on
   an unchanged rerun, never create an empty fix commit. Obtain explicit user
   authority and call `gate.rerun.record` with the failed evidence and fresh
   passing output. It fails closed unless the gate, clean worktree, HEAD, and
   append-only finalization binding are unchanged.
5. **Land.** After `review.round.finalize` advances the ticket to
   `ready-to-land`, call `landing.complete` from the recorded local base
   checkout with `runtime_closed: false`. If it returns `resynchronize`, call
   `landing.synchronize`, rerun every gate, and repeat both fresh review axes
   with attention to newly landed interactions before retrying. Resolve textual
   conflicts yourself with the `resolving-merge-conflicts` skill, then classify
   the result through `landing.conflict.record`. Substantive adaptations return
   to the same implementor as a fix round. Scope choices wait for user
   authority and are recorded before gates continue. When it returns
   `close-runtime`, close the completed implementor tab and call
   `landing.complete` again with `runtime_closed: true`.
6. **Record and refill.** Only a successful `landing.complete` may mark the
   ticket landed. It verifies a clean landed worktree, removes the native
   fallback without force or runs the exact repository cleanup argv, retains
   the branch, writes immutable landed evidence, updates `Base sha:`, removes
   the active runtime and serialized slot, and returns `schedule`. Update the
   registry row, then immediately pass the new landed state to `scheduler.plan`
   so every newly unblocked ticket can start.
7. **Evaluate terminal state.** When `scheduler.plan` returns no launch and no
   implementor is active, call `run.finalize`. It reads the accepted dependency
   graph and returns `active`, `waiting`, or `completed`. A blocked empty
   frontier is `waiting`, never success. Continue independent work when any
   ticket remains runnable. Close blocked work only from an explicit user
   decision naming each blocked or dependency-blocked ticket and reason; pass
   those closures together with `user_authorized: true`. The operation moves preserved runtime provenance to
   `## Closed ticket runtimes`, writes `## Run outcome`, and writes `SUMMARY.md`
   only when every ticket is `landed` or `closed`. The summary includes landed,
   blocked, and closed tickets, role provenance, review evidence, retained
   branches, and pending tracker action. For `final` or `live`, delegate the
   returned action to the persisted Matt tracker workflow only when current
   project authority allows it. `none` performs no writeback. Local completion
   and its summary are always recorded even when tracker action is pending or
   forbidden. Update your registry row with the returned status.

Session markers the implementor prints: `TICKET DONE NN`,
`TICKET BLOCKED NN: <question>`, `FIXES DONE NN`. Herdr agent status is the
wake authority, not marker text; implementors forget to print it.

## Event-driven wait cycle

Keep exactly one bounded `herdr.wait_any` call in flight while implementors are
active. Supply each runtime's durable id, ticket, session name, and latest pane
id, and set `coordinator` to `null`. The helper subscribes to every worker
pane's status plus pane exit events, waits for the subscription acknowledgement,
and only then takes its immediate snapshot. This ordering preserves events that
race with bootstrap. When no implementor is active, do not open an empty wait;
persist state, report the blocked or complete frontier, and end the turn.

An already-present or subsequent `idle`, `done`, `blocked`, or pane-exited
condition wakes the coordinator with the affected runtime identity. Herdr 0.9.1
does not expose model context utilization through its machine-readable API, so
this workflow never parses rendered pane or status text and never attempts a
context-triggered coordinator handoff.

If several workers settle together, process their events one at a time, then
serialize review and landing in dependency order. The helper's timeout is not
success. It returns a complete refreshed snapshot used to:

- persist compacted pane identifiers before another action;
- inspect `git status --short`, `git log --oneline <base>..HEAD`, and at most 40
  recent pane lines for workers that remain `working`;
- run `snapshot.check`, compare `Base sha:`, and evaluate coordinator context;
- run `scheduler.plan` so a persisted capacity change takes effect.

Apply [stall-check.md](references/stall-check.md) only on the timeout path.
After those checks, call wait-any again. Never replace this cycle with polling,
cron tools, scheduled prompts, background Bash monitors, Python parsing, or a
native harness task manager.

## Infrastructure retries

Worker crashes, Herdr transport failures, and launch failures use the same
three-retry policy. After recording the observed failure, call
`infrastructure.retry.record`. For `action: retry`, wait its returned bounded
increasing `delay_ms`, then relaunch in the same worktree with the exact returned
binding and the next attempt number. Never substitute a harness, model, effort,
skill, branch, or worktree. For `action: block`, leave only that ticket blocked
and immediately call `scheduler.plan` so independent ready tickets continue.

A blocked `retry exhausted` launch may return to `working` only through
`implementor.launch.recover`, and only after the user confirms that a
coordinator compatibility defect prevented prompt delivery while the exact
worker remained alive. Pass the Herdr socket and diagnostic to the helper. It
validates the immutable attempt-4 artifact, bound role, worktree, branch,
session, pane, and live `idle` or `done` worker. Execute only its returned
prompt array, never the start array, then record the observed attempt-4 outcome.

## Crash-restart

Only when a worker session actually fails (crash, unrecoverable context loss)
restart that ticket in the same worktree, **with the record bound in its table
row**: same harness, same model, and same effort, with the partial
work described in its `IMPORTANT CONTEXT` clause. Never escalate here and never
read the run-wide `Implementor:`. A crash is evidence about a process, not
about a model, and silently substituting a different one is how an override
gets lost to a network blip.

A network outage or a compaction is not immediately a worker failure: resume
the same session with a prompt first (or `claude --resume` in its worktree).
Re-prompt only if a compaction is followed by no edits across two bounded
timeout snapshots.

## Escalation

Distinct from crash-restart, and never call either one "the fallback rule".
Trigger: a ticket is still failing review after a **third** fix round. That is
evidence the bound model is not converging on this ticket.

- Escalation is **per ticket**. Record it in the ticket's `esc` column and in
  `## Decisions`. Never rewrite the run-wide `Implementor:`: one ticket's
  difficulty is not a judgement about the remaining tickets.
- `Coordinator.unattended` decides whether you may act alone. Default `block`:
  set the ticket's status to `blocked`, log what you would escalate to and why,
  run the scheduler for other unblocked tickets according to `Mode:`, and
  surface the block at the next progress tick. The run keeps moving and no
  model changes without the user. `escalate`
  pre-authorizes it for overnight runs.
- `unattended` governs this decision only. A `TICKET BLOCKED` question, a scope
  decision, and an invalid-record prompt always wait for the user.

## Coordinator continuity

Automatic coordinator handoff is disabled because Herdr 0.9.1 does not expose
normalized model context utilization. Record `Coordinator.handoff: disabled`
and `Coordinator.threshold: unavailable` in RESUME.md. Continue through the
active harness's normal context compaction without replacing the coordinator.
Never parse rendered pane output to estimate context use.

If the coordinator process exits or cannot recover after compaction, leave its
pane and durable state intact until the user starts a replacement with
`resume .scratch/<slug>`. The replacement follows the normal Resume procedure,
refreshes worker panes from Herdr, and claims ownership through the existing
coordinator compare-and-swap operations. It must not invoke any
`coordinator.handoff.*` operation. Full recovery rules:
[handoff.md](references/handoff.md).

## Resume

When invoked as `resume .scratch/<slug>` for a restart or replacement:

1. Run the helper `preflight` operation with the run's `RESUME.md` as
   `state_path`, then invoke `snapshot.check` and require `unchanged` with
   `scheduling_allowed: true`. A changed snapshot blocks resume scheduling and
   reports its changed inputs until the user explicitly runs the acceptance
   flow. Then validate the remaining fields against
   [resume-format.md](references/resume-format.md). It names the prefix, base,
   base sha, scheduling mode, branch template, all three role records,
   coordinator ownership, every active
   ticket's worktree and pane, and what remains. Missing, malformed, or
   unsupported schema versions stop the resume without migration. Any other
   mismatch also stops with an explanation; nothing is guessed.
   If `--coordinator` differs from the persisted record or the invoking
   session, stop and ask the user to start a matching replacement session.
   Differing `--implementor`, `--reviewer`, `--serial`, or `--parallel <N>`
   values are preference changes: validate them, write them, and log them in
   `## Decisions`. Implementor and Reviewer changes apply only to future
   launches.
2. `herdr pane list`; pane ids compact, so trust the list over RESUME.md.
   Rename your own tab to `coordinator` and label your own pane
   `coordinator <prefix>`, using `$HERDR_TAB_ID` and `$HERDR_PANE_ID`.
3. Compare `Base sha:` with the base checkout. If it moved, inspect every
   active branch against the new base, then record the observed sha.
4. Update your line in `.scratch/coordinators.md`.
5. When active runtimes exist, call `herdr.wait_any` with a short bounded
   timeout and `coordinator: null`. Persist every refreshed pane id from the
   returned complete snapshot. A valid active runtime remains active even when
   its recorded compact pane id changed; do not relaunch it.
6. Run `scheduler.plan`. If this is a replacement coordinator, use the normal
   coordinator claim and readiness operations after verifying that the previous
   process is no longer active. Do not invoke `coordinator.handoff.*`.
7. Report the state in a short list and end the turn.

## Rules that are not negotiable

- Preflight must succeed before creating or mutating RESUME.md. Never infer
  context use from rendered terminal text or invoke automatic handoff.
- Scheduling, review, and landing require an accepted, unchanged snapshot.
  Changed input hashes pause new work until explicit `snapshot.accept` records
  the revision and decision.
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
  then persist them with `review.policy.prepare` before worker launch. Claude may
  use its supported background facility; Pi runs synchronously through its
  normal shell tool. The full procedure is in
  [review-and-land.md](references/review-and-land.md).
- Claude implementors retain Matt's `implement` self-review. Pi implementors do
  one in-session Standards and Spec fallback without subagents. External
  Standards and Spec reviews always run as separate fresh Herdr sessions under
  the persisted Reviewer role.
- Persist a complete report before closing each reviewer pane. Any worktree
  status change contaminates that report, rejects its findings, and stops for
  manual cleanup without discarding the mutation. A finding always means FAIL.
- Never push or write to forge issues. The only permitted remote write is a
  persisted `final` or `live` update through the configured Matt tracker
  workflow when authoritative project policy allows it. All other remote
  writes remain forbidden.
- Enforce every project-specific safety constraint recorded in the shared
  brief. Do not invent restrictions that the repository does not require.
- Textual rebase conflicts are yours, never the implementor's. If the rebased
  result needs a substantive behavioral adaptation, send that work back to the
  same implementor as a fix round and review it again.
- Report outcomes faithfully: a red gate is reported as red with its output.
