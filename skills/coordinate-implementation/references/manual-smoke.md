# Manual smoke matrix

This matrix validates real Herdr and harness integration without making the
automated suite depend on paid model calls. Run it only with accounts and local
models the operator has explicitly approved. Do not push, write to a tracker,
or select `final` or `live` writeback during smoke verification. Use a throwaway
local Git repository and `writeback: none`. Use a local normalized source by
default, then use the non-local no-writeback case below.

## Shared fixture

1. Create a local repository with a `main` branch, two independent numbered
   tickets, one dependent ticket, deterministic no-network gates, and repository
   instructions that forbid remote writes.
2. Materialize `snapshot.json`, `spec.md`, and `issues/NN-*.md` under one ignored
   `.scratch/smoke-portable/` run folder.
3. Start from a clean Herdr workspace. Record Herdr, Bun, Git, Pi, and Claude
   versions plus the exact role triples used.
4. Run helper `preflight`, `roles.discover`, three `role.validate` requests,
   `worktree.preflight`, `review.policy.prepare`, and `snapshot.accept` with
   `writeback: none`. Write `run.ts` from `run-template.ts`, then drive every
   scenario through `runtime.ts start` and the `runtime.ts wait` loop.
5. For every scenario, retain RESUME.md, SUMMARY.md when produced, `events.ndjson`,
   `escalations/`, launch
   artifacts, gate evidence, both review reports, landed evidence, and relevant
   machine-readable Herdr snapshots. Reset the fixture between scenarios.

A pass requires exact argument arrays in launch artifacts, no shell
interpolation, no remote activity, no paid call initiated by a test command,
and a clean local integration checkout after each landed ticket.

## Non-local source, no writeback

Materialize one normalized snapshot whose source kind is `remote`, whose stable
references point at a disposable tracker fixture, and whose opaque Matt tracker
workflow is configured but never invoked. Accept it with `writeback: none` and
project remote writes forbidden. Complete the run and confirm SUMMARY.md says
no tracker action, no tracker command or network write occurs, and all source
references remain available for a later publishing workflow.

## Claude-only

Configure Coordinator, Implementor, and Reviewer as validated Claude triples.
Run one ticket from accepted snapshot through gates, independent Standards and
Spec reviews, verified reviewer pane closure, landing, verified implementor
pane closure, non-force cleanup, and `run.finalize`. Confirm each live pane
returns an exact close argv, cleanup remains blocked until `pane_not_found`, and
the summary reports all three Claude roles, accepted review evidence, the
retained branch, `completed`, and no tracker action.

## Pi-only

Configure all three roles as validated Pi triples. Confirm each launch uses
project approval and the explicit `implement` skill path, gates execute
synchronously, and implementor self-review contains both `## Standards` and
`## Spec`. Complete and finalize the run. Confirm no native subagent or
background-process extension was required.

## Mixed roles

Use Pi Coordinator, Claude Implementor, and Pi Reviewer, then repeat with the
opposite available mix if desired. Confirm each artifact uses its bound role
adapter and that a preference change affects only future launches. Finalize and
verify SUMMARY.md records the run-wide defaults, ticket-bound Implementor, and
reviewer provenance without inferring harnesses from model names.

## Parallel frontier

Use the two independent tickets with `--parallel 2`. Confirm the Engine
launches both in numeric order, both implementors remain active concurrently,
and temporary reviewers consume no implementor capacity. Confirm both tickets run
gates and reviews concurrently, and that each landing holds
`land-local.lock` only for its ancestor check and fast-forward. Land one ticket
and confirm the dependent ticket refills the free slot immediately.

## Conflict adaptation

Make both parallel branches change the same line. Land the first and confirm
the second's `landing.rebase.check` or `landing.complete` returns `rebase`. The
Engine prompts the same implementor, which rebases its own branch in its own
worktree and resolves the conflict there. Confirm the coordinator and Engine
never touch the ticket branch or base checkout, the next `landing.rebase.check`
starts a new integration cycle, every gate reruns, and both reviews rerun only when
the ticket's patch identity changed.

## Reviewer failure

For one axis, close the reviewer pane or inject a deterministic non-model launch
failure. Confirm three retries preserve the exact Reviewer triple, worktree,
axis, and review range with bounded increasing delays. Confirm exhaustion
blocks only that ticket, the other ready ticket continues, and no model is
substituted. Separately make a reviewer edit the worktree and confirm the
contaminated report is rejected without automatic cleanup.

## Herdr 0.9.1 coordinator continuity

Run preflight against Herdr 0.9.1 and confirm it succeeds with
`machine_api: true` and `normalized_context: false`. With the Engine running,
let the coordinator compact, then exit it. Confirm tickets keep progressing,
then start a replacement with `resume .scratch/<slug>` and confirm it claims
the next coordinator generation, attaches to the live Engine, and its first
`wait` resumes from the persisted Event Cursor.

## Engine supervision

Use the two independent tickets and one dependent ticket with `--parallel 2`.

1. Run `runtime.ts start`. Confirm tab `engine <prefix>` appears, `status`
   reports `liveness: alive`, and a second `start` returns `running` without
   opening another tab.
2. While both implementors work, close the Engine pane. Confirm the next
   `wait` returns `reason: "engine"` with `liveness: stale` and both
   implementor panes stay alive.
3. Run `start` again with the same script. Confirm a new lease generation
   starts, the event log records it, no implementor is relaunched, no second
   worker tab appears, and every launch artifact keeps its attempt number.
4. Edit `run.ts` and confirm `start` fails with `engine.script_changed` until
   `--accept-script <sha256>` names the new script.
5. Instruct one implementor, through its ticket text, to stop with
   `TICKET BLOCKED NN: <question>`. Confirm `wait` returns a `question`
   escalation for only that ticket while the other ticket keeps progressing.
   Answer it with `runtime.ts answer`, confirm the answer file is write-once
   (a second answer fails), and confirm the Engine delivers the answer to the
   same implementor pane and the ticket resumes to landing.
6. Confirm `engine.completed` arrives after the last landing, then
   `run.finalize` returns `completed` and writes SUMMARY.md.

## Completion and waiting checks

Leave one ticket blocked with no runnable dependency frontier and call
`run.finalize` without closures. Confirm the result and the global run file's
`run_status` say `waiting`, no SUMMARY.md exists, and the run is not presented as successful.
Then obtain explicit user authority naming the blocked ticket and reason, close
it through `run.finalize`, and confirm the terminal result is `completed`, the
runtime provenance moved to `## Closed ticket runtimes`, and SUMMARY.md reports
the closed work and retained branch.
