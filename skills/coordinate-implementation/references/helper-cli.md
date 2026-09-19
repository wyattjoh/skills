# Coordinate helper CLI

The bundled Bun helper is the public mechanical boundary for the coordinator.
It reads exactly one JSON request from stdin, writes exactly one JSON result to
stdout, and writes no human-oriented text around that result.

Run it as:

```bash
bun $SKILL_DIR/scripts/coordinate.ts
```

The coordinator supplies the JSON request on stdin. Do not infer success from
partial output. Check both the process exit code and the `ok` field.

## Versioned envelope

Every request uses this outer shape:

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "input": {}
}
```

Every result uses this outer shape:

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "ok": true,
  "result": {},
  "errors": []
}
```

Each error has a stable `code`, a human-readable `message`, and an actionable
`remediation`. The helper never migrates an unsupported request or state schema.

Exit codes:

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | The request and operation succeeded.                           |
| `1`  | The request was valid, but the requested operation failed.     |
| `2`  | The request JSON or request schema was invalid or unsupported. |

## `preflight`

Run preflight before creating or mutating run state. For a new run, use
`state_path: null`. On resume, provide the existing `RESUME.md` path so machine
capabilities and state schema are checked together.

```json
{
  "schema_version": 1,
  "operation": "preflight",
  "input": {
    "state_path": null,
    "skill_roots": null
  }
}
```

`skill_roots` may instead be an array of directories containing installed
skills. A null value checks the supported harnesses' standard global and local
skill locations.

Preflight checks all independent baseline requirements and returns every
failure in one result:

- the platform is macOS or Linux;
- `git`, `bun`, and `herdr` launch successfully;
- at least one of `pi` or `claude` launches successfully;
- Matt Pocock's required `implement` skill is installed;
- `herdr api schema --json` exposes the `session.snapshot` and
  `events.subscribe` methods used by Herdr 0.9.1;
- the optional state document uses supported schema version 1.

The Herdr capability result includes `normalized_context` for diagnostics, but
that value may be `false` and does not fail preflight. Herdr 0.9.1 lacks those
metrics, so new runs disable automatic coordinator handoff.

Preflight is read-only. A failed check does not create, rewrite, or migrate
`RESUME.md`.

## `state.validate`

Validate the schema marker of an existing Markdown state document independently.
This operation does not validate the document's later semantic fields:

```json
{
  "schema_version": 1,
  "operation": "state.validate",
  "input": {
    "state_path": ".scratch/example/RESUME.md"
  }
}
```

A schema-1 state contains exactly one integer marker:

```text
Schema version: 1
```

A missing, malformed, duplicate, or unsupported marker fails without changing
the file. Recovery is manual or requires a helper that explicitly supports the
recorded version.

## `snapshot.check`

Validate the normalized snapshot and compare its deterministic hashes with the
accepted Snapshot record in `RESUME.md`. This operation is read-only:

```json
{
  "schema_version": 1,
  "operation": "snapshot.check",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/RESUME.md",
    "writeback": null,
    "project_remote_writes": "allowed",
    "accepted_at": null
  }
}
```

`project_remote_writes` is always `allowed` or `forbidden`, resolved from the
repository's authoritative instructions. `snapshot.check` rejects a non-null
`writeback` value because policy changes require explicit acceptance.

The result status is `unaccepted`, `unchanged`, or `changed`.
`scheduling_allowed` is true only for `unchanged`. A changed result includes a
sorted `changed_inputs` list whose entries are `added`, `changed`, or `removed`.
It does not update the accepted record.

## `snapshot.accept`

Explicitly accept the current normalized snapshot and persist its hashes and
tracker policy in `RESUME.md`:

```json
{
  "schema_version": 1,
  "operation": "snapshot.accept",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/RESUME.md",
    "writeback": "final",
    "project_remote_writes": "allowed",
    "accepted_at": "2026-09-19T00:00:00Z"
  }
}
```

`accepted_at` must be a UTC ISO-8601 timestamp with whole seconds. Non-local
sources require `writeback` to be `none`, `final`, or `live` on initial
acceptance. A null local-file choice records `none` without prompting. On later
remote acceptance, null preserves the recorded mode; passing another mode is a
deliberate policy change. `forbidden` project authority rejects `final` and
`live`.

Success returns status `accepted` with `scheduling_allowed: true` only after the
managed `## Snapshot` record and an append-only decision have been written. The
record contains the revision, accepted time, source metadata, writeback mode,
and sorted path, source-reference, and SHA-256 entries.

The normalized manifest and coordinator rules are in
[normalized-snapshot.md](normalized-snapshot.md). The helper never invokes a
tracker command. It only validates and persists the opaque configured tracker
workflow name.

## `roles.discover`

Discover role choices before presenting setup questions:

```json
{
  "schema_version": 1,
  "operation": "roles.discover",
  "input": {}
}
```

The result contains `claude` and `pi` records in that order. Each record reports
availability and version, exact efforts parsed from installed harness help, and
model choices. Pi values come from `pi --list-models` as provider-qualified
ids. Claude Code reports the documented `fable`, `opus`, and `sonnet` aliases
and `custom: true`. An unavailable harness remains visible with
`available: false` but must not be offered in setup.

## `role.validate`

Validate each Coordinator, Implementor, and Reviewer record before persisting
it. Explicit skill flags pass one quoted triple:

```json
{
  "schema_version": 1,
  "operation": "role.validate",
  "input": {
    "role": "coordinator",
    "triple": "pi openai-codex/gpt-5.6-sol high"
  }
}
```

Structured setup passes `record` instead of `triple`:

```json
{
  "schema_version": 1,
  "operation": "role.validate",
  "input": {
    "role": "reviewer",
    "record": {
      "harness": "claude",
      "model": "sonnet",
      "effort": "medium"
    }
  }
}
```

Exactly one form is required. Validation checks that the harness is installed,
the effort appears in installed help, Pi models appear in the installed
catalog, and Claude custom values are not provider-qualified. An agreeing
`:<effort>` model suffix is split into the normalized record; a conflicting
suffix is rejected. Failure returns the rejected value and never a substituted
record.

## `worktree.preflight`

After resolving repository policy from authoritative instructions, run this
read-only preflight before creating or mutating RESUME.md and before creating a
worktree:

```json
{
  "schema_version": 1,
  "operation": "worktree.preflight",
  "input": {
    "policy": {
      "instruction_files": ["CLAUDE.md"],
      "worktree": {
        "kind": "repository",
        "tool": "repo-worktrees",
        "root": null,
        "create_argv": ["repo-worktrees", "create", "feature/ticket-04"]
      },
      "branch_naming": "feature/ticket-NN",
      "setup_argvs": [],
      "cleanup": "repository",
      "remote": "local-only",
      "remote_sync_argv": null,
      "commit": null
    }
  }
}
```

The operation verifies the exact required worktree executable and that a
repository create array invokes that tool. An unavailable prescribed tool fails
with `worktree.tool_unavailable`; native Git is never selected as a substitute.
This policy-aware check is separate from the generic baseline `preflight`,
which remains unchanged and runs before initial setup.

## `worktree.prepare`

Resolve and persist repository policy before creating one ticket worktree. The
coordinator must read repository instructions first and pass every governing
instruction path. A repository-prescribed tool is required exactly as recorded;
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

## `implementor.launch.recover`

Recover one exhausted attempt-4 launch only when the user has explicitly
confirmed that a coordinator compatibility defect prevented prompt delivery to
an already-running worker. This is not a general retry reset.

```json
{
  "schema_version": 1,
  "operation": "implementor.launch.recover",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "04",
    "socket_path": "/home/user/.config/herdr/sessions/default/herdr.sock",
    "timeout_ms": 3000,
    "user_authorized": true,
    "diagnostic": "Herdr 0.9.1 prompt argv compatibility defect",
    "recovered_at": "2026-09-19T20:00:00Z"
  }
}
```

The operation requires a blocked runtime at attempt 4 with `Retry: 3 of 3` and
`Phase: retry exhausted`. While holding the state lock, it validates the
run-wide and ticket-bound roles, immutable launch artifact, worktree, branch,
session, and pane. It also queries Herdr's machine-readable snapshot and
requires that exact named worker to be `idle` or `done` in the recorded pane.
Missing, moved, blocked, working, ambiguous, or unknown workers fail without
changing state.

Success preserves attempt 4, retry history, the immutable legacy artifact, and
the last failure diagnostic. For the known pre-fix Herdr 0.9.1 argv shape, the
helper validates the complete old prompt array and returns its corrected
positional equivalent without rewriting the artifact. It sets the ticket and
runtime phase to `working`, records the authorization, compatibility
diagnostic, and recovery timestamp, then returns only the validated `prompt`
command for the existing process. Execute that argument array directly. Never
execute the artifact's `start` command during recovery.
After prompt delivery, call `implementor.launch.record` for attempt 4 with the
observed result. Repeating the exact recovery before prompt delivery is
idempotent and returns `recovered: true`.

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

## `herdr.wait_any`

Wait for the first meaningful status from all active workers through the Herdr
control socket:

```json
{
  "schema_version": 1,
  "operation": "herdr.wait_any",
  "input": {
    "socket_path": "/home/user/.config/herdr/sessions/default/herdr.sock",
    "timeout_ms": 600000,
    "workers": [
      {
        "runtime_id": "example-02-attempt-1",
        "ticket": "02",
        "session": "example-02",
        "pane_id": "w1:p4"
      }
    ],
    "coordinator": null
  }
}
```

The helper opens a long-lived `events.subscribe` connection for every supplied
pane status plus pane exit events and waits for `subscription_started`. Only
then does it open a separate `session.snapshot` connection. Events arriving
between acknowledgement and snapshot are buffered and cannot be lost. If the
snapshot refreshes a compact pane id for a still-working session, the helper
subscribes to the refreshed ids before taking another snapshot.

An already-present or subsequent `idle`, `done`, or `blocked` status returns
`reason: status`. A missing, closed, or exited pane returns
`reason: pane_exited`. Both include the affected durable `runtime_id` and
complete worker snapshot. Simultaneous events are handled in socket order.

A timeout is successful transport but not worker completion. It returns
`reason: timeout`, `worker: null`, and the latest complete worker snapshot
captured within the requested end-to-end deadline. It does not start another
socket connection after that deadline expires. Use the snapshot for stall
detection, recovery, snapshot-integrity checks, and base checks. Each worker
includes both `pane_id` and `previous_pane_id`; persist refreshed ids before
another wait or launch decision. A valid session discovered under a refreshed
pane remains active and must not be relaunched.

Set `coordinator` to `null` for released Herdr runs. The input remains accepted
for legacy artifacts, but missing normalized context metrics return
`handoff: unavailable` rather than failing worker coordination.

Malformed events, malformed snapshots, disconnects, and socket failures return
a normal operation failure. Feed that failure into the shared infrastructure
retry policy. Do not fall back to polling, a cron, a shell loop, Python, or a
harness-native task manager.

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
queued tickets remain unchanged and can be selected by the next
`scheduler.plan` call.

## `review.policy.prepare`

Before any worker launch, persist the exact repository-derived gate and safety
contract:

```json
{
  "schema_version": 1,
  "operation": "review.policy.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "instruction_files": ["CLAUDE.md"],
    "ci_files": [".github/workflows/ci.yml"],
    "gates": [
      { "name": "format", "argv": ["bun", "run", "format:check"] },
      { "name": "test", "argv": ["bun", "test"] }
    ],
    "no_executable_gates": false,
    "safety_constraints": ["Do not push."],
    "no_additional_safety_constraints": false
  }
}
```

Every gate is an exact non-empty argument array. Names are unique. An empty gate
list requires `no_executable_gates: true`; an empty safety list requires
`no_additional_safety_constraints: true`. At least one authoritative
instruction file is required. This operation refuses to run after an active
ticket runtime exists.

The persisted policy fixes four total infrastructure attempts (the initial
attempt plus three retries) with delays of one, two, and four seconds. Its
execution record says Claude may use its supported background
facility, while Pi runs synchronously through its normal shell tool. It derives
`matt-implement` self-review for Claude implementors and
`standards-spec-single-session` for Pi implementors.

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
running any gate-recording logic. The evidence preserves that canonical
`worktree_path`, the policy argv, worktree HEAD, exit code, stdout, stderr, and
completion time. Evidence files are immutable: byte-identical recovery
succeeds, while different content at the same path fails.

## `gate.rerun.record`

Use this explicit recovery only when a normal failed gate passes on an unchanged
rerun and the user authorizes treating the first result as transient. It does
not permit an empty fix commit or bypass a still-red gate.

```json
{
  "schema_version": 1,
  "operation": "gate.rerun.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "previous_evidence_path": ".scratch/example/reviews/04-round-0-test-attempt-1.json",
    "evidence_path": ".scratch/example/reviews/04-round-0-test-attempt-2.json",
    "worktree_path": "/worktrees/example/ticket-04",
    "ticket": "04",
    "round": 0,
    "name": "test",
    "attempt": 2,
    "exit_code": 0,
    "stdout": "all tests passed",
    "stderr": "",
    "user_authorized": true,
    "diagnostic": "unrelated full-suite timeout passed on unchanged rerun",
    "completed_at": "2026-09-19T01:05:00Z"
  }
}
```

The operation requires the immediately preceding immutable evidence to be a
normal `failed` gate with `action: fix`. Ticket, round, configured argv,
canonical worktree, and HEAD must match, the worktree must remain clean, and
the current append-only finalization must still bind that same tip. Success
writes separate immutable passing evidence, preserves the failed evidence,
clears only the pending append-fix sentinel, reconstructs the exact review
range and commit count, returns finalization to `gates`, and records the user
authorization in `## Decisions`. A changed HEAD, dirty worktree, different gate,
stale evidence, missing authority, or nonzero rerun fails without changing
state. Repeating the byte-identical operation is idempotent.

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
the preceding attempt's artifact path and accepted retry evidence. A retry must keep
the same ticket, round, axis, Reviewer role, canonical worktree, branch, base
ref, context paths, landed tickets, gate evidence paths, and reviewed HEAD.
Only the new artifact and report paths, pane, and derived session may differ.

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
FAIL and is copied into one consolidated fix request. For `action: fix`, the
result sets `fix_request_authorized: true`: ordinary review remediation is
pre-authorized by the standing fix loop and must be sent without a user prompt.
Rounds below three return the next round; a FAIL after fix round three returns
`escalate` without model substitution. Earlier report and sidecar paths are
never overwritten.

## `landing.synchronize`

Claim the single serialized finalization slot and synchronize a clean ticket
branch against the current local integration branch:

```json
{
  "schema_version": 1,
  "operation": "landing.synchronize",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "repository_path": "/repo",
    "worktree_path": "/worktrees/example/ticket-04",
    "ticket": "04",
    "remote_sync_argv": null,
    "completed_at": "2026-09-19T01:12:00Z"
  }
}
```

`local-only` policy persists and requires null, then never fetches. `repository`
policy persists one exact non-empty argv array authorized by repository
instructions or explicit run policy. The caller must match it byte for byte;
an arbitrary command cannot replace the required synchronization. The command
executes without shell interpolation before
the helper rebases onto the persisted local `Base` branch.

Only one ticket may own `## Serialized finalization`. Other implementors remain
active, but another ticket cannot enter synchronization, final gates, review,
or landing until the slot clears. Success returns the full-SHA `review_range`,
commit count, resolved commit and fix policy, and `run-gates`. Multiple commits
are accepted by default. `single` and `squash` policy require one commit. A fix
under default `append` policy must preserve the previous reviewed tip as an
ancestor and add a new commit.

A textual conflict returns `resolve-conflicts`, the sorted conflict paths, and
leaves the rebase plus serialized slot in place. A non-conflict Git failure is
an operation error.

## `landing.conflict.record`

After completing the conflicted rebase, record its coordinator classification:

```json
{
  "schema_version": 1,
  "operation": "landing.conflict.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "04",
    "classification": "textual",
    "decision": null,
    "user_authorized": false,
    "completed_at": "2026-09-19T01:15:00Z"
  }
}
```

The helper requires a clean worktree, no unmerged paths, and policy-compliant
commit shape. `textual` returns `run-gates`. `substantive` returns `fix` to the
same bound implementor and records the current tip for fix-policy enforcement.
A `scope` classification with `user_authorized: false` returns `await-user` and
does not record a decision. Repeat it only after the user authorizes the exact
non-empty decision; that call appends durable authority and returns
`run-gates`.

## `landing.complete`

After `review.round.finalize` accepts both axes and advances the serialized
record to `ready-to-land`, complete the fast-forward and cleanup:

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
    "completed_at": "2026-09-19T01:20:00Z"
  }
}
```

The helper verifies immutable Standards, Spec, and implementor self-review
evidence against the current ticket tip. If the local base moved and refuses a
fast-forward, the operation returns `resynchronize`, clears stale review
bindings, and retains the serialized ticket. Rerun synchronization, every gate,
and both fresh review axes before retrying.

A successful fast-forward inspects the exact pane persisted in the active
runtime. A live pane returns `close-runtime` with
`runtime_closed: false`, the pane ID, and the exact shell-free
`herdr pane close <persisted-pane-id>` argv without cleaning the worktree or
releasing serialized state. Execute only that argv and repeat the same call.
Only Herdr's `pane_not_found` result permits native cleanup to check that the
worktree is clean and landed, run `git worktree remove <path>` without force,
and verify the branch remains. Repository cleanup instead requires its exact
`cleanup_argv` and receives the same postconditions. Success writes immutable
landed JSON evidence with machine-observed `runtime_closed: true`, updates the
ticket and `Base sha:`, removes the active runtime and serialized slot, appends
landed and retained-branch provenance, and returns `schedule`. Call
`scheduler.plan` only after that durable result.

## Legacy automatic coordinator handoff operations

New Herdr 0.9.1 runs record `handoff: disabled` and must not invoke these
operations. They remain available only to validate or recover a legacy run that
records `handoff: yes` and has normalized Herdr context metrics. Preparation on
a disabled run fails with `coordinator.handoff_disabled` before writing an
artifact or launching a successor.

### `coordinator.handoff.prepare`

For a compatible legacy run, prepare the successor without changing ownership:

```json
{
  "schema_version": 1,
  "operation": "coordinator.handoff.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "run_path": ".scratch/example",
    "artifact_path": ".scratch/example/briefs/handoff-5-attempt-1.json",
    "session": "coordinator-example-5",
    "successor_pane": "w1:p2",
    "predecessor_session": "coordinator-example-4",
    "socket_path": "/tmp/herdr.sock",
    "timeout_ms": 5000,
    "phase": "waiting",
    "attempt": 1,
    "max_retries": 3,
    "previous_artifact_path": null
  }
}
```

The operation reads the persisted Coordinator role and current ready ownership,
then independently re-observes the predecessor through Herdr. Only normalized
Herdr `context_used` and `context_limit` values can satisfy the exact 80 percent
threshold. It rejects unsafe phases and changed predecessor panes, publishes a
run-local launch artifact with no-replace semantics, and returns exact
`launch.start` and `launch.prompt` argument arrays. It never changes ownership.
Attempts 2 through 4 require the preceding artifact and reject a changed
predecessor or successor role.

### `coordinator.handoff.retry`

Record a failed successor launch against its artifact:

```json
{
  "schema_version": 1,
  "operation": "coordinator.handoff.retry",
  "input": {
    "artifact_path": ".scratch/example/briefs/handoff-5-attempt-1.json",
    "diagnostic": "successor exited before claim"
  }
}
```

The shared infrastructure policy returns delays of 1000, 2000, and 4000
milliseconds for failed attempts 1 through 3. Failed attempt 4 returns
`action: block`. The operation atomically publishes immutable
`<artifact_path>.retry.json` evidence containing the artifact SHA-256, exact
diagnostic, and complete decision. Identical recovery sets
`evidence_recovered: true`; changed evidence at that path fails closed. The
returned binding preserves the exact run, predecessor, and successor role.
Retry fails if ownership has changed, so it cannot surrender or replace the
predecessor implicitly.

### `coordinator.handoff.ready`

After schema validation and unchanged `snapshot.check`, establish readiness:

```json
{
  "schema_version": 1,
  "operation": "coordinator.handoff.ready",
  "input": {
    "artifact_path": ".scratch/example/briefs/handoff-5-attempt-1.json",
    "socket_path": "/path/to/herdr.sock",
    "timeout_ms": 1000,
    "project_remote_writes": "forbidden"
  }
}
```

The operation validates the artifact against the ready predecessor and selected
Coordinator role, validates snapshot hashes again, semantically matches every
one-based active runtime to a unique active ticket-table row, subscribes before
snapshotting through wait-any, and rejects a missing worker. Under the ownership
lock, the full current runtime identity set must still exactly equal the
pre-wait set, including ticket, session, attempt, and prior pane. Only then does
that atomic mutation persist refreshed worker panes, compare-and-swap the
predecessor generation, and record `readiness: ready`. Changed snapshots, stale
generations, invalid state, and changed successor panes fail without changing
ownership.

### `coordinator.handoff.verify`

After reading `COORDINATOR READY <marker>` from the exact successor pane, verify
and authorize the predecessor close:

```json
{
  "schema_version": 1,
  "operation": "coordinator.handoff.verify",
  "input": {
    "artifact_path": ".scratch/example/briefs/handoff-5-attempt-1.json",
    "observed_marker": "coordinator-ready-5-w1:p2"
  }
}
```

Only matching generation, pane, bound role, readiness, and marker return
`close_predecessor: true` plus an exact shell-free `herdr pane close` argument
array. Every failure keeps the predecessor open.

## Coordinator ownership operations

`Coordinator ownership:` in RESUME.md contains `generation`, `pane`,
`harness`, `model`, `effort`, `readiness`, and `marker`. Coordinator and snapshot mutation
operations share one short-lived state lock, serialized recovery guard, and
same-directory temporary file replacement. A lock older than 30 seconds may be
recovered only when its recorded same-machine process is no longer alive. Lock
release verifies the claimant token, so an old claimant cannot remove a newer
lock. Interrupted temporary files are never read as state.

### `coordinator.claim`

The selected successor calls this operation after its Herdr agent has started.
The persisted `Coordinator:` role must equal `successor_role`.

```json
{
  "schema_version": 1,
  "operation": "coordinator.claim",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "expected_generation": 4,
    "expected_predecessor_pane": "wJE:p1",
    "expected_predecessor_role": {
      "harness": "claude",
      "model": "opus",
      "effort": "high"
    },
    "successor_pane": "wJE:p2",
    "successor_role": {
      "harness": "pi",
      "model": "openai-codex/gpt-5.6-sol",
      "effort": "high"
    }
  }
}
```

Exactly one concurrent claimant can replace generation 4. Success advances the
generation to 5, records the successor role with `readiness: claiming`, and returns a
deterministic generation-specific marker. A stale generation, wrong predecessor
pane or role, role mismatch, or successor equal to the current pane fails
without changing state.

### `coordinator.ready`

After reconstructing the run and arming its wait, the successor marks only its
own claim ready:

```json
{
  "schema_version": 1,
  "operation": "coordinator.ready",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "generation": 5,
    "pane": "wJE:p2",
    "marker": "coordinator-ready-5-wJE:p2"
  }
}
```

The successor then prints the exact returned marker in its pane. A mismatched
or already-replaced claim fails without mutation.

### `coordinator.verify`

The predecessor reads the marker from the successor's Herdr pane and supplies
that independently observed value:

```json
{
  "schema_version": 1,
  "operation": "coordinator.verify",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "generation": 5,
    "pane": "wJE:p2",
    "observed_marker": "coordinator-ready-5-wJE:p2"
  }
}
```

Verification succeeds only when generation, pane, ready state, and marker all
match. Until then, the predecessor remains open. This makes a launched but
failed successor observable without producing two ready owners.

## `run.finalize`

Evaluate the accepted dependency graph after a scheduling pass has no active
implementor or new launch. The operation verifies the snapshot again, applies
only explicitly authorized blocked-ticket closures, records `## Run outcome`,
and writes the final local summary only for a completed run:

```json
{
  "schema_version": 1,
  "operation": "run.finalize",
  "input": {
    "run_path": ".scratch/example",
    "state_path": ".scratch/example/RESUME.md",
    "summary_path": ".scratch/example/SUMMARY.md",
    "closures": [{ "ticket": "07", "reason": "User accepted the deferred scope" }],
    "user_authorized": true,
    "project_remote_writes": "allowed",
    "completed_at": "2026-09-19T12:00:00Z"
  }
}
```

Pass an empty `closures` array and `user_authorized: false` for ordinary status
evaluation. Every requested closure must name a currently `blocked` ticket or
a queued ticket whose unsatisfied dependencies are also landed, blocked,
closed, or named in the same closure set. Each closure needs a single-line
reason. Nonempty closures require explicit user authority. The helper marks
those rows `closed`, moves any preserved runtime blocks from
`## Active tickets` to `## Closed ticket runtimes`, and appends the user
decision. It never deletes a retained branch or blocked worktree.

The result status is:

- `active` when an implementor phase remains active or a queued ticket has all
  dependencies landed;
- `waiting` when no runnable frontier exists but blocked or dependency-blocked
  work remains;
- `completed` only when every ticket is `landed` or explicitly `closed`.

Only `completed` writes the immutable run-local `SUMMARY.md`. It reports landed,
blocked, and closed work, run-wide and ticket-bound role provenance, review
evidence, retained landed and closed-work branches, and tracker action. Local
sources and `writeback: none` return `not-applicable`. Persisted `final` or
`live` policy returns the configured Matt tracker workflow as `pending` when
current project authority allows remote writes, or `forbidden` when current
authority no longer permits them. The helper never calls a tracker. The
coordinator delegates a pending action and always preserves the local summary.
