# Review, gate, fix, and landing pipeline

## Resolve the pipeline before workers launch

Read every repository instruction file and the CI configuration before creating
an implementor session. Resolve exact gate argument arrays and project safety
constraints into `review.policy.prepare`. A command is authoritative only when
an instruction, CI job, or repository task referenced by one of those sources
names it. Never infer a command from a language, manifest, lockfile, or tool
installed on the machine.

Pass an explicit empty `ci_files` array when the repository has no CI. If no
executable gate exists, pass an empty `gates` array and
`no_executable_gates: true`. If there are no safety constraints beyond the
listed repository instructions, pass an empty `safety_constraints` array and
`no_additional_safety_constraints: true`. These explicit declarations prevent
silence from looking like completed discovery.

The operation persists `## Review policy` before any active ticket exists. It
also records the fixed three-attempt infrastructure policy, gate execution
modes, and harness-appropriate self-review:

- Claude coordinators may use Claude Code's supported background command
  facility for long gates.
- Pi coordinators run gates synchronously through the normal shell tool. Do not
  require a background-process extension.
- Claude implementors complete Matt's `implement` self-review.
- Pi implementors complete Standards and Spec in the same existing session. Do
  not require a subagent extension.

## Synchronize before gates

Parallel workers branch from the landed base that existed when they started.
Once a worker is idle with policy-compliant commits, synchronize that branch to
the latest local integration branch before final gates or review. Do not fetch
or assume a remote unless the persisted Repository policy requires that exact
synchronization.

Only one ticket may be in synchronize, gate, review, and land at a time. Process
ready tickets in dependency order. This keeps each review diff limited to that
ticket instead of making later base commits appear as reversals.

Resolve textual conflicts yourself with the `resolving-merge-conflicts` skill,
never by asking the implementor to operate the rebase. Preserve the intent of
both the landed change and the ticket. If that cannot be done without a scope
decision, stop and ask the user. After the rebase completes, update the active
ticket's `Branch` and `Phase` fields, and verify the commit shape on
`<base>..HEAD` against the persisted Repository policy.

A clean textual resolution is coordination work. A substantive behavioral
adaptation is implementation work: send it to the same worker as a fix round,
apply the persisted fix-commit policy, synchronize again, and restart this
pipeline from the gates.

## Run and record gates

Run every gate's persisted `argv` exactly from the ticket worktree. Never
convert it to an interpolated shell string. Record each attempt with
`gate.record`, including the worktree path and complete stdout and stderr in a
run-local evidence file. The helper requires the canonical active-runtime
worktree and binds that pass to both its path and current HEAD.

Classify outcomes precisely:

- `passed`: exit code zero, continue to the next gate.
- `failed`: the gate ran and found a problem. Return its command and output to
  the implementor as the first item in one fix request. Do not retry it as
  infrastructure.
- `infrastructure_failed`: the command could not be run or its execution
  facility failed. Use the returned delay and retry the exact persisted argv.
  The second and third attempts keep the same ticket, worktree, and
  configuration. A third infrastructure failure blocks only this ticket.

Do not launch external reviewers until every configured gate has a recorded
pass for the current commit and round.

## Capture implementor self-review

Capture the complete implementor self-review before external review. Claude's
report comes from Matt's `implement` workflow. Pi's single-session fallback
must contain both `## Standards` and `## Spec` sections. The fallback happens
in the existing implementor session and does not launch temporary reviewers.

`review.round.finalize` validates the method against the harness bound in the
active ticket runtime, not the run-wide Implementor preference. A later
preference change therefore cannot reinterpret an existing ticket.

## Launch independent Herdr reviewers

Run Standards and Spec as separate fresh Herdr sessions. Do not use native
subagents or ask one reviewer to cover both axes.

For each axis and attempt:

1. Create a new Herdr tab and pane in the ticket worktree.
2. Call `review.launch.prepare` with the current persisted Reviewer role, the
   new pane, the integration diff range, and axis source paths. Pass
   `previous_artifact_path: null` for attempt 1. For attempts 2 and 3, pass the
   immediately preceding attempt's artifact path.
3. Require the operation to report an empty `status_before`. It refuses a dirty
   baseline because later mutations could not be attributed safely.
4. Execute only the returned `launch.start` and `launch.prompt` arrays.
5. Wait for the fresh session to finish. Capture its complete output yourself.
6. Call `review.launch.record` with that output before closing the pane.
7. Close the reviewer pane only after the report and JSON evidence file exist
   and RESUME.md references the attempt.

The helper builds the strict prompt. Standards receives repository instruction,
architecture, domain, and contract paths. Spec receives the agreed spec and
ticket paths plus the landed ticket list. Both prompts prohibit edits and
require each finding to contain:

- severity: `critical`, `high`, `medium`, or `low`;
- source location as a real `path:positive-line`, never a placeholder;
- concrete rationale;
- suggested fix.

Reports contain only actionable defects, not observations or personal style
preferences. Each finding uses a `## Finding` block and the final non-empty line
is exactly `PASS` or `FAIL`. Any finding requires `FAIL`; only no findings may
produce `PASS`.

A malformed result is reviewer infrastructure failure. Retry in a new Herdr
session with the same Reviewer role and worktree. Use the returned bounded delay
and stop this ticket after attempt three. The helper reads the preceding
artifact and evidence before authorizing the retry. Never change the ticket,
round, model, effort, harness, axis, worktree, branch, base ref, context paths,
landed-ticket context, gate evidence, reviewed HEAD, or source set during an
infrastructure retry.

## Mutation protection

`review.launch.prepare` captures `git status --porcelain=v1
--untracked-files=all` through the sanitized Git boundary. `review.launch.record`
first verifies the supplied artifact path and every declared or derived output
path remain canonically inside the run directory, then captures status again.
Any difference contaminates that axis even when the report otherwise looks
useful.

On contamination:

- persist the complete report and both status snapshots;
- reject all findings from that report;
- stop the ticket with `manual_cleanup`;
- leave every reviewer change untouched;
- ask the user to inspect and clean the worktree before a fresh review.

Never reset, stash, commit, or discard reviewer changes automatically.

## Finalize and fix

After both axes are accepted, call `review.round.finalize` with their JSON
evidence paths and the complete self-review. The operation persists the
self-review and returns one strict round verdict.

A clean `PASS` from both axes returns `land`. If either axis has findings, the
operation writes one consolidated fix request containing every Standards and
Spec finding. Send that one request to the existing implementor session. It
also states the persisted fix-commit policy and requires the worker to rerun
all gates, repeat its harness-appropriate self-review, and print `FIXES DONE
NN`.

Include the implementor in the next wait-any call. When it returns a terminal
status, restart the pipeline from the recorded gates. Increment the ticket row's
`rounds` column for each completed fix round.

Each fix round receives new gate evidence bound to its new HEAD, new fresh
Standards and Spec sessions, and new report files. Evidence is immutable and
byte-identical recovery is the only permitted path reuse. Never overwrite an
earlier round. Rounds one through three use the same bound implementor and
reviewer configurations. A `FAIL` after the third fix round returns `escalate`;
record the decision and wait for the configured explicit escalation authority.
Never substitute a model.

## Landing

After a finalized clean round, land immediately from the recorded base checkout:

```sh
cd <base checkout> && git merge --ff-only <branch>
```

The fast-forward is the serialization point. If it is refused, the base moved
after review. Return to the ticket worktree, synchronize against the latest
base according to persisted repository policy, resolve textual conflicts as
above, rerun every gate, and run both fresh review axes focused on newly landed
interactions and conflict-resolution hunks. If either axis finds a substantive
adaptation, send one consolidated fix round to the same implementor, then rerun
the full pipeline. Only then retry the fast-forward.

After landing, close the implementor tab and finish the worktree lifecycle
according to the persisted Repository policy:

```sh
herdr tab close <tab>
```

A repository-required cleanup tool is authoritative. The native fallback first
verifies that the worktree is clean and the branch is landed, removes it without
force, and retains the branch. Never silently change cleanup tools or delete a
retained branch.

Set the ticket row's `status` to `landed` and fill its `sha`, leaving bound role
columns untouched as provenance. Remove its `## Active tickets` block, update
`Base sha:`, review evidence, retained branches, `.scratch/coordinators.md`, and
any scope decision. Then call `scheduler.plan`; it immediately fills newly
available implementor capacity in deterministic ticket order.

## Scope decisions

When a ticket includes sound work that a later ticket expected to own, keep it
and narrow the later ticket to verify what remains before implementing more.
Record the decision in `## Decisions` and in the later ticket's
`IMPORTANT CONTEXT` clause. Unwinding usually costs more than a narrowed
follow-up.

A scope decision always waits for the user. `Coordinator.unattended` does not
authorize it.
