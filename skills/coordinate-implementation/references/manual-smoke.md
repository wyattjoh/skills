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
   `snapshot.accept` with `writeback: none`, and `review.policy.prepare`.
5. For every scenario, retain RESUME.md, SUMMARY.md when produced, launch
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

Use the two independent tickets with `--parallel 2`. Confirm `scheduler.plan`
returns both in numeric order, both implementors remain active concurrently,
and temporary reviewers consume no implementor capacity. Land one ticket and
confirm the dependent ticket refills the free slot immediately while review and
landing remain serialized.

## Conflict adaptation

Make both parallel branches change the same line. Land the first, synchronize
the second, and resolve the textual conflict as coordinator work. First verify
a purely textual resolution proceeds through gates. Repeat with a resolution
that changes behavior, classify it `substantive`, and confirm work returns to
the same implementor as a fix round before fresh gates and reviews.

## Reviewer failure

For one axis, close the reviewer pane or inject a deterministic non-model launch
failure. Confirm three retries preserve the exact Reviewer triple, worktree,
axis, and review range with bounded increasing delays. Confirm exhaustion
blocks only that ticket, the other ready ticket continues, and no model is
substituted. Separately make a reviewer edit the worktree and confirm the
contaminated report is rejected without automatic cleanup.

## Herdr 0.9.1 coordinator continuity

Run preflight against Herdr 0.9.1 and confirm it succeeds with
`machine_api: true` and `normalized_context: false`. Start one worker, call
`herdr.wait_any` with `coordinator: null`, and confirm status and refreshed pane
ids still arrive through the event-driven path. Confirm RESUME.md records
`handoff: disabled` and `threshold: unavailable`, and that
`coordinator.handoff.prepare` fails with `coordinator.handoff_disabled` before
writing an artifact.

## Completion and waiting checks

Leave one ticket blocked with no runnable dependency frontier and call
`run.finalize` without closures. Confirm the result and the global run file's
`run_status` say `waiting`, no SUMMARY.md exists, and the run is not presented as successful.
Then obtain explicit user authority naming the blocked ticket and reason, close
it through `run.finalize`, and confirm the terminal result is `completed`, the
runtime provenance moved to `## Closed ticket runtimes`, and SUMMARY.md reports
the closed work and retained branch.
