# Review, gate, fix, and landing pipeline

The coordinator resolves the review policy below before starting the Engine.
Everything after that section describes what the Engine's built-in steps do
for each ticket, so the coordinator can read evidence, answer escalations, and
perform explicitly authorized recovery after `runtime.ts stop`. Operation
contracts are in [engine-operations.md](engine-operations.md).

## Resolve the review policy before the Engine starts

Read every repository instruction file and the CI configuration. Resolve exact
gate argument arrays and project safety constraints into
`review.policy.prepare`. A command is authoritative only when an instruction,
CI job, or repository task referenced by one of those sources names it. Never
infer a command from a language, manifest, lockfile, or tool installed on the
machine.

When repository instructions require a wrapper for heavy commands, such as a
shared `flock` lock that serializes builds, lints, and tests across worktrees,
include that wrapper in each gate's argv so Engine gate runs contend for the
same lock as worker runs.

Pass an explicit empty `ci_files` array when the repository has no CI. If no
executable gate exists, pass an empty `gates` array and
`no_executable_gates: true`. If there are no safety constraints beyond the
listed repository instructions, pass an empty `safety_constraints` array and
`no_additional_safety_constraints: true`. These explicit declarations prevent
silence from looking like completed discovery.

The operation persists `## Review policy` before any active ticket exists,
including the fixed four-attempt infrastructure policy and the
harness-appropriate self-review: Claude implementors complete Matt's
`implement` self-review, and Pi implementors complete Standards and Spec in the
same existing session.

## Integrate before gates

Each ticket integrates independently; several tickets may run gates, reviews,
and landing in parallel. Once a worker is idle with policy-compliant commits,
the Engine calls `landing.rebase.check`, which checks the ticket tip against
the latest local integration branch (after the persisted `remote_sync_argv`,
if any; `local-only` policy never fetches).

- When the tip contains the base, it binds the ticket's `Integration` record
  and returns `run-gates` with a full-SHA `review_range`. Every gate and review
  uses that range, so each review diff covers only that ticket.
- When the base advanced, it returns `rebase` and a prompt the Engine sends to
  the same bound implementor. The implementor rebases its own branch in its own
  worktree, resolves any conflicts there, and prints `REBASE DONE NN`. The next
  check records a new integration cycle. Every gate reruns after a rebase;
  both accepted reviews are kept only when the ticket's patch id is unchanged.
  A conflict that needs a scope decision arrives as a `question` escalation.

## Gates

The Engine runs every gate's persisted `argv` exactly from the ticket worktree
and records each attempt with `gate.record`:

- `passed`: continue to the next gate.
- `failed`: the gate found a problem. Its command and output lead one fix
  request to the implementor; it is never retried as infrastructure.
- `infrastructure_failed`: the command could not run. The Engine retries the
  exact argv with the returned delay; a fourth failure blocks only this ticket
  with a `retry_exhausted` escalation.

External reviewers launch only after every gate passes for the current commit.

## Self-review and independent reviewers

The implementor's complete self-review is captured before external review.
Pi's single-session fallback must contain both `## Standards` and `## Spec`.
`review.round.finalize` validates the method against the harness bound in the
ticket's runtime, not the run-wide Implementor preference.

Standards and Spec each run as a fresh Herdr session under the persisted
Reviewer role; native subagents never stand in for them. The helper builds the
strict prompt: Standards receives repository instruction, architecture,
domain, and contract paths; Spec receives the agreed spec, ticket paths, and
the landed ticket list. Every finding carries a severity (`critical`, `high`,
`medium`, or `low`), a real `path:line`, a rationale, and a suggested fix. The
final line is exactly `PASS` or `FAIL`, and any finding requires `FAIL`.

A malformed result is reviewer infrastructure failure, retried in a new
session with the same role and worktree up to attempt four. Nothing about the
review (ticket, round, role, axis, worktree, range, or context) changes during
an infrastructure retry.

## Mutation protection

`review.launch.prepare` requires a clean worktree and captures
`git status --porcelain=v1 --untracked-files=all`; `review.launch.record`
captures it again. Any difference contaminates that axis: the Engine persists
the report and both snapshots, rejects all its findings, and stops the ticket
with `manual_cleanup`. Never reset, stash, commit, or discard reviewer changes
automatically; the user inspects and cleans the worktree before a fresh review.

## Finalize and fix

`review.round.finalize` returns `land` when both axes pass. Otherwise it writes
one consolidated fix request with every Standards and Spec finding, the
persisted fix-commit policy, and the requirement to rerun all gates, repeat the
self-review, and print `FIXES DONE NN`. Review fixes are pre-authorized: the
Engine sends the request to the same implementor immediately, then restarts
the pipeline from the rebase check. Round count is never a permission
boundary; the Engine emits `attention.review_churn` at the configured round and
keeps looping.

Each round gets new gate evidence, new reviewer sessions, and new report files.
Evidence is immutable, and byte-identical recovery is the only permitted path
reuse.

A failed gate that passes on an unchanged rerun never gets an empty commit.
With explicit user authority and the Engine stopped, `gate.rerun.record`
records the fresh pass against the preceding failed evidence and returns the
ticket to `gates` (see [helper-cli.md](helper-cli.md)).

## Landing

When the ticket's integration reaches `ready-to-land`, the Engine calls
`landing.complete`. It verifies both accepted axes and the self-review cover
the reviewed patch, then holds `<git-common-dir>/land-local.lock` (shared with
the `land-local` skill) only for the clean-base check, the ancestor check, and
`git merge --ff-only`. When another ticket landed first, it returns `rebase`
and the ticket loops back through the rebase check; the reviews rerun only if
the patch id changed. A dirty base checkout (`landing.base_dirty`) or a lock
timeout (`landing.lock_timeout`) changes nothing and needs investigation.

After the fast-forward, the Engine closes the persisted pane, and cleanup runs
only after Herdr reports `pane_not_found`: native cleanup runs
`git worktree remove` without `--force`, and repository cleanup runs its exact
authorized `cleanup_argv`. Both keep the branch. The helper then writes landed
evidence, marks the ticket landed at its full tip, updates `Base sha:`, and the
Engine schedules the next frontier.

## Scope decisions

When a ticket includes sound work that a later ticket expected to own, keep it
and narrow the later ticket to verify what remains before implementing more.
Record the decision in `## Decisions` and in the later ticket's
`IMPORTANT CONTEXT` clause. A scope decision always waits for the user.
