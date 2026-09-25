# Engine operations

The Engine calls these helper operations in-process while it drives a run.
They also remain available through `bun $SKILL_DIR/scripts/coordinate.ts`
with the envelope in [helper-cli.md](helper-cli.md), which the helper refuses
while an Engine holds the run's lease. The coordinator never calls them during
normal supervision. Read this file to interpret the evidence and RESUME.md
records they write, or to perform an explicitly authorized recovery after
`runtime.ts stop`.

## `worktree.prepare`

Create one ticket worktree under the repository policy that
`worktree.preflight` persisted. The Engine passes every governing instruction
path from that record. A repository-prescribed tool is required exactly as recorded;
if it is unavailable, the operation fails without native Git fallback.

When no lifecycle tool is prescribed, pass `kind: native`, `tool: null`, a
user-selected `root`, and `create_argv: null`. Native Git runs with inherited
repository-location variables removed. A null commit policy resolves to
`commits: multiple` and `fixes: append`.

```json
{
  "schema_version": 1,
  "operation": "worktree.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "repository_path": "/repo",
    "base_branch": "main",
    "branch": "feature/ticket-04",
    "worktree_name": "ticket-04",
    "policy": {
      "instruction_files": ["CLAUDE.md"],
      "worktree": {
        "kind": "native",
        "tool": null,
        "root": "/worktrees/example",
        "create_argv": null
      },
      "branch_naming": "feature/ticket-NN",
      "setup_argvs": [],
      "cleanup": "native-safe",
      "remote": "local-only",
      "remote_sync_argv": null,
      "commit": null
    }
  }
}
```

A repository tool uses `kind: repository`, names `tool`, supplies its exact
`create_argv`, and adds `expected_worktree_path` to the operation input. Setup
commands are also arrays and run only after the worktree path and branch have
been verified. Success returns the normalized durable policy and the actual
path, branch, base, and creation or recovery status.

## `implementor.launch.prepare`

Validate one ticket's role against both the installed harness and the persisted
run-wide `Implementor:` record, validate its worktree, construct exact Herdr and
harness argument arrays, write the run-local JSON launch artifact, and
atomically persist runtime provenance before process launch. Artifact
containment uses canonical paths, so a run-local symlink cannot redirect a
launch outside the run.

```json
{
  "schema_version": 1,
  "operation": "implementor.launch.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "artifact_path": ".scratch/example/briefs/launch-04.json",
    "ticket": "04",
    "worktree_path": "/worktrees/example/ticket-04",
    "branch": "feature/ticket-04",
    "session": "example-04",
    "tab": "implement example 04",
    "pane": "w1:p4",
    "role": {
      "harness": "pi",
      "model": "openai-codex/gpt-5.6-sol",
      "effort": "high"
    },
    "implement_skill_path": "/home/user/.pi/agent/skills/implement/SKILL.md",
    "prompt": "You are implementing ticket 04...",
    "attempt": 1,
    "max_attempts": 3
  }
}
```

Pi requires `implement_skill_path`; Claude requires null. Pi start arguments
include project approval and the explicit required skill. Claude uses its
automatic permission mode and the `/implement` prompt prefix. The result's
`launch.start` and `launch.prompt` are `{command, args}` objects. Execute them
as arrays without shell interpolation.

The active runtime writes its ticket-bound `Implementor:` role as compact JSON
with exactly `harness`, `model`, and `effort`. Recovery parses that JSON instead
of splitting display text, so custom Claude model values containing spaces are
preserved byte-for-byte.

Preparing the same bound attempt is idempotent and returns `recovered: true`.
A different persisted role, worktree, branch, required skill path, or
incompatible attempt conflicts with the durable runtime instead of rewriting
it. Failed validation leaves state unchanged and removes a newly created
artifact; an identical artifact that existed before the attempt is preserved.

## `implementor.launch.record`

Persist the observed result after executing the prepared start and prompt
arrays. Success records `working`. Failure requires an exact diagnostic and
records `blocked` plus `Phase: launch failed` without removing the runtime or
changing its role.

```json
{
  "schema_version": 1,
  "operation": "implementor.launch.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "04",
    "attempt": 1,
    "status": "failed",
    "diagnostic": {
      "stage": "prompt",
      "exit_code": 17,
      "stderr": "agent rejected the request"
    }
  }
}
```

Use `diagnostic: null` with `status: started`. Recording is accepted only from
`launch prepared` or `working`; retry and terminal phases fail closed. A failed
launch remains an active `working` ticket with `Phase: launch failed` until
`infrastructure.retry.record` decides whether to retry or block. A later retry
increments `attempt` but keeps the bound harness, model, effort, worktree,
branch, and exact required implement skill path.

The schema-1 field name `max_attempts` is retained for compatibility with the
landed launch contract, but its value is the maximum retry count. Pass `3`.
Attempt 1 is the initial launch and attempts 2 through 4 are the three retries.
The runtime renders this truthfully as `Retry: 0 of 3` through `3 of 3`.

## `scheduler.plan`

Select dependency-ready queued tickets within the current implementation cap:

```json
{
  "schema_version": 1,
  "operation": "scheduler.plan",
  "input": {
    "mode": "parallel",
    "max_implementors": 3,
    "tickets": [
      { "number": "01", "dependencies": [], "status": "landed" },
      { "number": "02", "dependencies": ["01"], "status": "queued" }
    ],
    "runtimes": [
      {
        "runtime_id": "review-07-standards",
        "ticket": "07",
        "role": "reviewer",
        "state": "active"
      }
    ]
  }
}
```

Parallel mode requires a positive cap. Serial mode requires cap 1. Only
`implementor` runtimes with `state: active` consume capacity. Pass
`state: terminal` for blocked or exhausted runtime records retained for
recovery. Active reviewers are represented so the helper can prove they do not
consume slots. A queued ticket with a valid
active implementor runtime is never returned for another launch. Unknown
blocking tickets, duplicate ticket numbers, duplicate runtime ids, and multiple
active implementors for one ticket fail before any launch.

The result reports `capacity`, `active_implementors`, `available_slots`, and
`launch_tickets`. Ready tickets are sorted by numeric ticket number and sliced
to the available slots. Call this operation after every landing and after a
persisted mode or cap change. A reduced cap returns no launch while the active
count is above the cap; it never terminates a worker.

## TypeSafe stall assessment operations

A stall check uses three operations to keep semantic evidence immutable and
action separate from evaluation.

### `stall.assessment.prepare`

Write the bounded state described in [stall-check.md](stall-check.md) under the
run directory and prepare a request:

```json
{
  "schema_version": 1,
  "operation": "stall.assessment.prepare",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/assessments/stall/01-timeout-2-state.json",
    "request_path": ".scratch/example/assessments/stall/01-timeout-2-request-1.json",
    "previous_evidence_path": null
  }
}
```

### `stall.assessment.evaluate`

Evaluate that exact request with the pinned TypeSafe model:

```json
{
  "schema_version": 1,
  "operation": "stall.assessment.evaluate",
  "input": {
    "run_path": ".scratch/example",
    "request_path": ".scratch/example/assessments/stall/01-timeout-2-request-1.json",
    "evidence_path": ".scratch/example/assessments/stall/01-timeout-2-evidence-1.json"
  }
}
```

### `stall.assessment.apply`

Bind the evidence back to the immutable request and select the code-owned
action:

```json
{
  "schema_version": 1,
  "operation": "stall.assessment.apply",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/assessments/stall/01-timeout-2-apply-state-1.json",
    "request_path": ".scratch/example/assessments/stall/01-timeout-2-request-1.json",
    "evidence_path": ".scratch/example/assessments/stall/01-timeout-2-evidence-1.json"
  }
}
```

Collect `state_path` immediately before apply using the same bounded schema.
Apply allows only the current observation timestamp to advance. It rejects the
evidence as stale if any ticket, worker, pane-tail, Git, phase, or prior
observation binding changed after prepare.

`apply` returns `wait`, `reprompt`, `pause`, or `retry-worker`. For `reprompt`,
execute only the returned `prompt_argv`; the prompt is a versioned policy
constant, never model-generated text. `retry-worker` enters the existing
`infrastructure.retry.record` path. `pause` leaves the worker unchanged and
waits for user authority or stronger evidence.

The request and evidence paths must resolve inside the run, new artifacts use
exclusive creation, and apply verifies request hash, state hash, assessment id,
and attempt. TypeSafe, credential, transport, rate-limit, malformed-response,
and write failures persist failed evidence and fail the operation. Never fall
back to an agent judgment after such a failure.

Do not retry automatically. If the operator explicitly retries an unchanged
provider failure, prepare a new request path with the prior failed
`evidence_path` as `previous_evidence_path`. The helper verifies the complete
link and increments the attempt. A new timeout observation starts a new
assessment id at attempt 1 instead.

## `infrastructure.retry.record`

Record one worker, Herdr, or launch infrastructure failure against an active
runtime:

```json
{
  "schema_version": 1,
  "operation": "infrastructure.retry.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "02",
    "attempt": 1,
    "failure": "herdr",
    "diagnostic": "event socket disconnected"
  }
}
```

The helper reads the exact role, worktree, branch, implement skill, session, and
tab binding from the active runtime block. The input cannot replace any of
those values. Attempts 1, 2, and 3 may return `action: retry` with delays 1000,
2000, and 4000 milliseconds. The returned `binding` is the only configuration
used for the next attempt. After attempt 4 fails, all three retries are
exhausted: the operation returns `action: block`, records
`Phase: retry exhausted`, and marks only that ticket blocked. Independent
queued tickets remain unchanged and can be selected by the next scheduling
pass.

## `gate.record`

After executing one persisted gate argv, record its exact output:

```json
{
  "schema_version": 1,
  "operation": "gate.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "evidence_path": ".scratch/example/reviews/04-round-0-test-attempt-1.json",
    "worktree_path": "/worktrees/example/ticket-04",
    "ticket": "04",
    "round": 0,
    "name": "test",
    "attempt": 1,
    "status": "failed",
    "exit_code": 1,
    "stdout": "",
    "stderr": "one test failed",
    "completed_at": "2026-09-19T01:00:00Z"
  }
}
```

A normal red gate returns `action: fix`; it is not an infrastructure retry. An
`infrastructure_failed` attempt returns the next attempt and bounded delay until
attempt four, which returns `blocked`. The helper resolves the supplied
worktree canonically and requires it to equal the active ticket runtime before
running any gate-recording logic. When the ticket has an `Integration` record,
it must be in `gates` at the current HEAD, and the evidence binds its cycle as
`integration_cycle`. A pass adds the gate to `passed_gates`; when both reviews
were kept across a rebase and every configured gate has passed in the cycle,
the record returns to `ready-to-land`. A red gate records `fixing` and the
append-only baseline. The evidence preserves that canonical
`worktree_path`, the policy argv, worktree HEAD, exit code, stdout, stderr, and
completion time. Evidence files are immutable: byte-identical recovery
succeeds, while different content at the same path fails.

## `review.launch.prepare`

Prepare each Standards or Spec axis independently in a newly created Herdr pane:

```json
{
  "schema_version": 1,
  "operation": "review.launch.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "previous_artifact_path": null,
    "artifact_path": ".scratch/example/reviews/04-round-0-standards-attempt-1.json",
    "report_path": ".scratch/example/reviews/04-round-0-standards-attempt-1.md",
    "ticket": "04",
    "round": 0,
    "axis": "standards",
    "worktree_path": "/worktrees/example/ticket-04",
    "branch": "feature/ticket-04",
    "base_ref": "main",
    "pane": "w1:p5",
    "role": { "harness": "claude", "model": "sonnet", "effort": "medium" },
    "context_paths": ["CLAUDE.md", ".claude/rules/testing.md"],
    "landed_tickets": ["01", "02", "03"],
    "gate_evidence_paths": [
      ".scratch/example/reviews/04-round-0-format-attempt-1.json",
      ".scratch/example/reviews/04-round-0-test-attempt-1.json"
    ],
    "attempt": 1
  }
}
```

The role must equal the persisted Reviewer record and the branch and canonical
worktree must equal the active ticket runtime. One passing evidence file must
match each persisted gate by ticket, round, canonical worktree, current
worktree HEAD, name, and exact argv; failed, missing, duplicated, or stale gates
reject launch. The helper then captures a sanitized Git status baseline and
rejects a dirty worktree. It constructs a unique session name from the run
prefix, ticket, round, axis, and attempt. Returned Herdr start and prompt
commands are argument arrays and require no shell interpolation.

Attempt 1 requires `previous_artifact_path: null`. Attempts 2 through 4 require
the unique immediately preceding attempt's artifact path and accepted retry
evidence. A retry must keep the same ticket, round, axis, Reviewer role,
canonical worktree, branch, base ref, context paths, landed tickets, gate
evidence paths, and reviewed HEAD. Only the new artifact and report paths, pane,
and derived session may differ. Attempt identities are indexed across run-local
launch artifacts and RESUME references, so a different caller-selected path
cannot restart or reuse an attempt number.

The generated prompt prohibits mutation and non-actionable preferences. Every
finding must have severity, a real `path:positive-line` location, rationale,
and suggested fix. Placeholders such as `unknown`, `none`, and `n/a` are
malformed. The final non-empty line is exactly `PASS` or `FAIL`, and any finding
requires `FAIL`.

## `review.launch.record`

Before closing the reviewer pane, persist its complete output:

```json
{
  "schema_version": 1,
  "operation": "review.launch.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "artifact_path": ".scratch/example/reviews/04-round-0-standards-attempt-1.json",
    "status": "completed",
    "report": "# Standards review\n\nPASS\n",
    "diagnostic": null,
    "completed_at": "2026-09-19T01:05:00Z"
  }
}
```

Before reading or writing evidence, the helper canonically verifies the
supplied artifact path, the artifact's declared path, its report path, and the
derived JSON sidecar are inside the run directory. The declared artifact path
must exactly equal the supplied path. It then writes the full Markdown report,
a structured JSON evidence sidecar, and a RESUME.md evidence reference.
Reports, sidecars, self-reviews, and fix requests are immutable: byte-identical
recovery is allowed, but different content at an existing path fails rather
than destroying prior evidence. A malformed verdict retries as reviewer
infrastructure. `infrastructure_failed` instead requires `report: null` and an
exact diagnostic. Attempts one through three return the fixed delay and next
attempt; attempt four blocks only that ticket.

Git status is captured again. Any difference marks the review `contaminated`,
rejects its findings, and preserves both the report and every worktree change.
After evidence is durable, a live reviewer pane returns `action: close-runtime`,
its eventual `after_close_action`, and the exact shell-free
`herdr pane close <persisted-pane-id>` argv. Execute only that argv and repeat
the byte-identical call. Immutable writes and the RESUME.md reference are
idempotent. The repeated call returns the recorded disposition only after
Herdr reports `pane_not_found`; the caller cannot assert closure.

## `review.round.finalize`

After both accepted axes, persist harness self-review and compute one strict
round outcome:

```json
{
  "schema_version": 1,
  "operation": "review.round.finalize",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "04",
    "round": 0,
    "standards_evidence_path": ".scratch/example/reviews/04-round-0-standards-attempt-1.md.json",
    "spec_evidence_path": ".scratch/example/reviews/04-round-0-spec-attempt-1.md.json",
    "self_review_path": ".scratch/example/reviews/04-round-0-self-review.md",
    "self_review_method": "matt-implement",
    "self_review_report": "# Implementor self-review\n\nNo findings.\n",
    "fix_request_path": ".scratch/example/briefs/fixes-04-round-0.md",
    "completed_at": "2026-09-19T01:10:00Z"
  }
}
```

The self-review method is checked against the ticket-bound implementor, not the
run-wide default. Pi requires `standards-spec-single-session` and both
`## Standards` and `## Spec` report sections. Claude requires `matt-implement`.

Two accepted PASS reports return `action: land`. Any finding makes the round
FAIL and is copied into one consolidated fix request. Every failure returns
`action: fix`, `fix_request_authorized: true`, and the next round regardless of
round number. Review remediation is pre-authorized by the standing fix loop and
must be sent without a user prompt. Earlier report and sidecar paths are never
overwritten.

## `landing.rebase.check`

Check whether a clean ticket branch already contains the local integration
branch, and bind its per-ticket integration. Call it whenever an implementor
reports its work or its fixes are done:

```json
{
  "schema_version": 1,
  "operation": "landing.rebase.check",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "repository_path": "/repo",
    "worktree_path": "/worktrees/example/ticket-04",
    "ticket": "04",
    "completed_at": "2026-09-19T01:12:00Z"
  }
}
```

When the persisted `repository` remote policy has a `remote_sync_argv`, the
helper runs that exact argv first, without shell interpolation, from the base
checkout. `local-only` policy never fetches. The helper then runs
`git merge-base --is-ancestor <base> HEAD` in the ticket worktree. It never
rebases, checks out, or edits anything itself.

Every ticket integrates independently; there is no run-wide slot, so many
tickets may run gates and reviews in parallel. Results carry `action`, `phase`,
the integration `cycle`, full-SHA `review_range`, `commit_count`, commit policy,
`patch_id`, `reviews_kept`, and `prompt`:

- `run-gates`: the tip contains the base. Run every gate against the returned
  range. A repeated check at an unchanged tip and base is idempotent.
- `fix-commits`: the commit shape violates `single` or `squash` policy. Return
  it to the bound implementor.
- `rebase`: the base advanced. The helper records `rebase-required`; send the
  returned `prompt` to the bound implementor, which rebases its own branch in
  its own worktree, resolves conflicts there, and prints `REBASE DONE NN`.
  Then call `landing.rebase.check` again: once the tip contains the base, it
  records the new integration cycle and returns `run-gates`.
- `land`: the integration is already `ready-to-land`.

Multiple commits are accepted by default. `single` and `squash` policy require
one commit. A fix under the default `append` policy must keep every commit
patch id recorded when the gate or review failed as a prefix and add at least
one commit; otherwise the check fails with `landing.fix_policy_violated`. A
dirty worktree or an in-progress rebase, merge, or cherry-pick fails without
changing state.

## `landing.complete`

After the ticket's `Integration` record reaches `ready-to-land`, complete the
fast-forward and cleanup:

```json
{
  "schema_version": 1,
  "operation": "landing.complete",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "repository_path": "/repo",
    "worktree_path": "/worktrees/example/ticket-04",
    "evidence_path": ".scratch/example/reviews/04-landed.json",
    "ticket": "04",
    "cleanup_argv": null,
    "lock_wait_seconds": 110,
    "completed_at": "2026-09-19T01:20:00Z"
  }
}
```

The helper verifies immutable Standards, Spec, and implementor self-review
evidence against the reviewed tip, and requires the ticket branch to equal the
integrated tip. `lock_wait_seconds` is optional (0 to 110, default 110).

The lock step lands through the same lock as the `land-local` skill:

```text
flock -w 110 <git-common-dir>/land-local.lock bun $SKILL_DIR/scripts/land-locked.ts <base-checkout> <base> <branch>
```

Inside the lock, `land-locked.ts` requires the base checkout to be clean
(exit 4), requires `git merge-base --is-ancestor <base> <branch>` (exit 5,
`REBASE_REQUIRED`), and runs `git merge --ff-only <branch>` (exit 6 on
failure). `flock` exits 1 on timeout. The helper passes the reviewed full tip
SHA as `<branch>`, so a branch moved after review cannot land. A tip that is
already an ancestor of the base skips the lock, so a repeated call resumes
cleanup. A dirty base checkout fails with `landing.base_dirty` and a timeout
with `landing.lock_timeout`; neither changes state. When the base advanced,
the operation returns `action: rebase` with the implementor `prompt` and
records `rebase-required`, keeping the accepted reviews for the patch-id check
in the next `landing.rebase.check`.

A successful fast-forward inspects the exact pane persisted in the active
runtime. A live pane returns `close-runtime` with
`runtime_closed: false`, the pane ID, and the exact shell-free
`herdr pane close <persisted-pane-id>` argv without cleaning the worktree or
changing ticket state. Execute only that argv and repeat the same call.
Only Herdr's `pane_not_found` result permits native cleanup to check that the
worktree is clean and landed, run `git worktree remove <path>` without force,
and verify the branch remains. Repository cleanup instead requires its exact
`cleanup_argv` and receives the same postconditions. Success writes immutable
landed JSON evidence with machine-observed `runtime_closed: true`, updates the
ticket and `Base sha:`, removes the active runtime and its integration, appends
landed and retained-branch provenance, and returns `schedule`. The Engine
schedules the next frontier only after that durable result.
