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
also records the fixed four-attempt infrastructure policy, gate execution
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
Once a worker is idle with policy-compliant commits, call
`landing.synchronize`. It atomically claims `## Serialized finalization`, then
rebases that clean ticket branch onto the latest local integration branch. Pass
`remote_sync_argv: null` for `local-only` policy. A `repository` remote policy
persists the exact argument array authorized by repository instructions or an
explicit run policy, then rejects any caller-selected substitute. The helper
never assumes a remote name or fetch command.

Only one ticket may own synchronization, final gates, review, and landing at a
time. Other implementors continue working and do not consume this serialized
slot. Process ready tickets in dependency order. Use the returned full-SHA
`review_range`, not a worker-start base, for every gate and review. This keeps
each review diff limited to that ticket instead of making later base commits
appear as reversals.

A `resolve-conflicts` result leaves the serialized slot and Git conflict in
place. Resolve textual conflicts yourself with the `resolving-merge-conflicts`
skill, never by asking the implementor to operate the rebase. Preserve the
intent of both the landed change and the ticket. After the rebase completes,
call `landing.conflict.record`.

Classify a clean textual resolution as `textual`; the helper verifies the clean
range and advances to gates. Classify a substantive behavioral adaptation as
`substantive`; it returns the same ticket to the bound implementor as a fix
round and preserves the reviewed tip needed to enforce append-only fixes. If a
scope decision is required, first record `scope` with `user_authorized: false`,
stop, and ask the user. Only a later call with `user_authorized: true` and the
exact decision records authority and advances to gates.

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
  Attempts two through four keep the same ticket, worktree, and configuration.
  A fourth infrastructure failure blocks only this ticket.

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
   `previous_artifact_path: null` for attempt 1. For attempts 2 through 4, pass
   the immediately preceding attempt's artifact path.
3. Require the operation to report an empty `status_before`. It refuses a dirty
   baseline because later mutations could not be attributed safely.
4. Execute only the returned `launch.start` and `launch.prompt` arrays.
5. Wait for the fresh session to finish. Capture its complete output yourself.
6. Call `review.launch.record` with that output before closing the pane.
7. When it returns `close-runtime`, execute only the returned Herdr pane-close
   argv, then repeat the byte-identical `review.launch.record` call. The report,
   JSON evidence, and RESUME.md reference are idempotent. Continue with
   `after_close_action` only when the repeated call observes the pane absent
   and returns that action.

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
and stop this ticket after attempt four. The helper reads the preceding
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
Spec finding. This ordinary remediation is pre-authorized by the run's standing
fix loop. Send that one request to the existing implementor session immediately,
without asking the user for permission. It also states the persisted fix-commit
policy and requires the worker to rerun
all gates, repeat its harness-appropriate self-review, and print `FIXES DONE
NN`.

Include the implementor in the next wait-any call. Immediately call
`landing.synchronize` after any terminal remediation result, including a terminal
result returned directly by the blocking Herdr prompt. That terminal result is
already the wake signal: do not summarize, end the turn, or wait for another
event first. Use the helper to validate the clean appended tip, then restart the
pipeline from every recorded gate. Increment the ticket row's `rounds` column
for each completed fix round.

Do not manufacture an empty commit when a failed gate passes on an unchanged
rerun. Stop and obtain explicit user authority. Then call `gate.rerun.record`
with the immediately preceding failed evidence and fresh passing output. The
helper requires the same clean worktree, HEAD, configured gate, and append-only
finalization binding, preserves both evidence files, records the authorization,
and returns the ticket to `gates`. Any real source change still requires the
persisted fix-commit policy and a new commit.

Each fix round receives new gate evidence bound to its new HEAD, new fresh
Standards and Spec sessions, and new report files. Evidence is immutable and
byte-identical recovery is the only permitted path reuse. Never overwrite an
earlier round. Every failed round uses the same bound implementor and reviewer
configurations, returns `action: fix`, and increments `next_round`. Round count
is never a permission boundary: send the consolidated request immediately and
continue until a fresh round passes or the worker reports a genuine external
blocker.

`review.escalation.authorize` is not part of the ordinary loop. Use it only to
recover an already-blocked legacy run or when the operator explicitly directs a
per-ticket role replacement. For `continue-existing`, execute only the returned
`prompt-existing` action. For `replace-implementor`, execute the returned
`close-runtime` argument array, retry the same authorization until it returns
`prepare-replacement`, then call `implementor.launch.prepare` with the exact
returned role and prompt. Never restart the old worker, overwrite review
evidence, substitute a model, or rewrite the run-wide Implementor default. The
helper preserves the superseded runtime provenance and makes repeated
authorization calls idempotent.

## Landing

After a finalized clean round advances serialized state to `ready-to-land`,
call `landing.complete` with a run-local immutable evidence path. The helper
validates that both accepted PASS axes and the implementor self-review cover
the synchronized ticket tip, then attempts the fast-forward from the recorded
local base checkout.

A refused fast-forward returns `resynchronize` instead of guessing success. The
helper clears the stale final-review binding but retains the serialized ticket.
Call `landing.synchronize` again, resolve conflicts as above, rerun every gate,
and run both fresh review axes focused on newly landed interactions and
conflict-resolution hunks. Only a new `ready-to-land` result may be retried.

Once the tip is landed, the helper inspects the exact persisted Herdr pane. A
live pane returns `close-runtime` plus the only permitted shell-free
`herdr pane close` argv without cleaning the worktree or releasing serialized
state. Execute that argv and repeat the same `landing.complete` call. Only a
machine-observed `pane_not_found` result permits cleanup. The helper then
verifies the ticket tip remains landed and the worktree is clean. Native
cleanup runs `git worktree remove <path>` without `--force` and verifies the
branch still exists. Repository cleanup requires the exact authorized
`cleanup_argv`, then receives the same removal and branch retention checks. The
helper writes immutable JSON evidence, marks the ticket landed at its full tip,
removes its active block and serialized slot, updates `Base sha:`, and appends
retained-branch and landed-evidence records before it returns `schedule`.

After that success, the helper has already published the landed state to the
global run file. Call `scheduler.plan`. It immediately fills newly available implementor capacity in
deterministic ticket order.

## Scope decisions

When a ticket includes sound work that a later ticket expected to own, keep it
and narrow the later ticket to verify what remains before implementing more.
Record the decision in `## Decisions` and in the later ticket's
`IMPORTANT CONTEXT` clause. Unwinding usually costs more than a narrowed
follow-up.

A scope decision always waits for the user. `Coordinator.unattended` does not
authorize it.
