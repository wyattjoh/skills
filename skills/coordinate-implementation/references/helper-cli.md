# Coordinate helper CLI

The bundled Bun helper reads exactly one JSON request from stdin, writes
exactly one JSON result to stdout, and writes no human-oriented text around
that result. The coordinator calls it for setup, ownership, `run.finalize`,
`agreements.update`, and the explicitly authorized recovery operations
documented here. The Engine calls the remaining operations in-process; they
are documented in [engine-operations.md](engine-operations.md) for recovery
and evidence reading only. Run a recovery operation only with explicit user
authority and only after `runtime.ts stop` confirms no Engine holds the run's
lease; the helper refuses a mutating operation while an Engine holds it.

Run it as:

```bash
bun $SKILL_DIR/scripts/coordinate.ts
```

Do not infer success from partial output. Check both the process exit code
and the `ok` field.

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

A result may also carry a `warnings` array of issues with the same shape. It
appears only when a best-effort global run file write failed
(`global_state.write_failed` or `global_state.heartbeat_failed`); `ok`, the
exit code, and RESUME.md are unaffected. Report the warning and continue. See
[registry.md](registry.md).

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
- the optional state document uses supported schema version 2.

The Herdr capability result includes `normalized_context` for diagnostics, but
that value may be `false` and does not fail preflight.

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

A schema-2 state contains exactly one integer marker:

```text
Schema version: 2
```

A missing, malformed, duplicate, or unsupported marker fails without changing
the file. Recovery is manual or requires a helper that explicitly supports the
recorded version. A schema-1 run, which used the removed serialized
finalization slot, fails with `state.schema_unsupported`: finish it with the
previous skill version or start a new run. The helper never migrates it.

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

Pass an optional `state_path` once RESUME.md exists. After the checks pass,
the helper then persists the serialized policy as RESUME.md's
`## Repository policy` record, the same record `worktree.prepare` writes. The
Engine requires that record before its first launch.

## `implementor.runtime.migrate`

Use this narrow recovery only after the user explicitly authorizes replacing an
interrupted Claude implementor with the exact persisted Pi Implementor default.
It does not create a new run or worktree and does not modify ticket code.

```json
{
  "schema_version": 1,
  "operation": "implementor.runtime.migrate",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "12",
    "expected_binding": {
      "worktree_path": "/worktrees/example/ticket-12",
      "branch": "feature/ticket-12",
      "role": { "harness": "claude", "model": "opus", "effort": "medium" },
      "implement_skill_path": "/implement",
      "session": "example-12",
      "tab": "implement example 12",
      "pane": "w1:p12",
      "artifact_path": ".scratch/example/briefs/launch-12.json",
      "attempt": 1,
      "retry": "0 of 3",
      "phase": "working"
    },
    "replacement_role": { "harness": "pi", "model": "openai-codex/gpt-5.6-sol", "effort": "high" },
    "user_authorized": true,
    "completed_at": "2026-09-23T12:00:00Z"
  }
}
```

The old binding must exactly match the active ticket and its immutable launch
artifact. The replacement must exactly match the persisted Pi `Implementor:`
role and pass role validation. Herdr must report `pane_not_found` for the exact
old pane; a live pane, ambiguous machine response, stale role, or mismatched
artifact fails without changing state. Success archives the runtime block under
`## Closed ticket runtimes`, records the explicit decision, and writes immutable
run-local evidence at `briefs/implementor-runtime-migration-NN.json` containing
the old artifact hash, Herdr pane-closure observation, the ticket's
`Integration` record and cycle, and a snapshot of HEAD, Git status, and changed-file contents. After the atomic
RESUME update, the helper writes
`briefs/implementor-runtime-migration-NN.json.commit.json`, binding the exact
evidence hash and both state references. Launch consumers fail closed unless the
commit marker and both references match; retry the identical authorized request
to reconcile a pending transaction. The migration preserves the old launch
artifact, branch, worktree, dirty files, and the `Integration` record in its
evidence. Dirty `working` worktrees are retained as-is; `gates`-phase migration
requires a clean worktree and an untouched gates-phase `Integration` record for
the current tip. The result says `action: prepare-replacement` and reports
`integration_preserved`. A replacement launch must use the exact preserved
worktree and branch, must match the captured snapshot before the first launch,
and carries the preserved `Integration` record into its new active block.

## `implementor.runtime.migration.recover`

A gates-phase migration cannot proceed directly to gates or review. After
`implementor.runtime.migrate`, authorize an explicit transition to a new
integration cycle using the exact migration evidence hash:

```json
{
  "schema_version": 1,
  "operation": "implementor.runtime.migration.recover",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "13",
    "migration_evidence_sha256": "<sha256-of-exact-migration-evidence-bytes>",
    "user_authorized": true,
    "completed_at": "2026-09-23T12:05:00Z"
  }
}
```

Recovery revalidates the exact committed migration, clean worktree, HEAD, and
changed-file snapshot, and requires that no replacement runtime is active yet.
It records the user-authorized decision without changing ticket files and
returns `action: prepare-and-check-rebase`. Prepare a replacement launch in the
preserved worktree and branch; its active block carries the preserved
`Integration` record as `rebase-required`. Then call `landing.rebase.check`,
which records the next integration cycle; only that fresh gates phase permits
new gate records or reviewer launches. Each gate record binds the integration
cycle, so old gate artifacts cannot pass review after recovery. Repeating
recovery is idempotent. Working-phase migrations do not need this operation.

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
the ticket's `fixing` integration under the `append` fix policy must still
bind that same tip. Success writes separate immutable passing evidence,
preserves the failed evidence, clears only the pending append-fix baseline,
returns the integration to `gates` with this gate passed, and records the user
authorization in `## Decisions`. A changed HEAD, dirty worktree, different gate,
stale evidence, missing authority, or nonzero rerun fails without changing
state. Repeating the byte-identical operation is idempotent.

## `review.attempt.supersede`

Record only a user-authorized interrupted Claude review attempt whose exact
Herdr pane is already absent. This writes immutable interruption evidence, not
a review report, verdict, or accepted axis.

```json
{
  "schema_version": 1,
  "operation": "review.attempt.supersede",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "artifact_path": ".scratch/example/reviews/13-round-0-standards-attempt-1.json",
    "expected_binding": {
      "ticket": "13",
      "round": 0,
      "axis": "standards",
      "attempt": 1,
      "reviewer": { "harness": "claude", "model": "opus", "effort": "medium" },
      "worktree_path": "/worktrees/example/ticket-13",
      "branch": "feature/ticket-13",
      "base_ref": "<full-base-sha>",
      "pane": "w1:p13",
      "session": "example-review-13-r0-standards-a1",
      "tab": "review example 13 r0 standards a1",
      "reviewed_head": "<full-ticket-sha>",
      "status_before": "",
      "context_paths": ["CLAUDE.md", ".claude/rules/testing.md"],
      "landed_tickets": ["01", "02"],
      "gate_evidence_paths": [
        ".scratch/example/reviews/13-round-0-format-attempt-1.json",
        ".scratch/example/reviews/13-round-0-test-attempt-1.json"
      ],
      "artifact_sha256": "<sha256-of-exact-launch-artifact-bytes>"
    },
    "user_authorized": true,
    "reason": "Reviewer pane exited before producing a report.",
    "completed_at": "2026-09-23T12:10:00Z"
  }
}
```

The binding and artifact hash must match exactly. The operation requires the
persisted Reviewer default to be Pi, the exact ticket worktree and branch to be
clean at the reviewed HEAD, a gates-phase `Integration` record at that HEAD and
base with no review evidence, complete passing evidence for every
configured gate, and no report at the old attempt's report path. Herdr must
return `pane_not_found` for the persisted pane. Success writes
`status: superseded`, `action: retry`, and `next_attempt` to the immutable JSON
sidecar next to the old report path, then adds a superseded reference to
RESUME.md. After that atomic state update, it writes
`<report-path>.json.commit.json`, binding the evidence hash and exact state
reference. Retry the same supersession request to reconcile a pending write;
review consumers refuse to proceed until the sidecar, reference, and marker all
match. The state reference carries a monotonic per-ticket-round supersession
generation, also bound by the sidecar and commit marker. A prior axis's pending
commit blocks superseding another axis in that round until the exact request
commits. Legacy passing gates without this field are captured as generation 0
only in the supersession sidecar, bound to their exact SHA-256; they cannot be
used as new gate evidence. The operation preserves the prior launch artifact
and does not claim a verdict. It returns `gate_rerun_required: true`;
`gate.record` serializes evidence publication with the same state lock and
snapshots that generation. Before a Pi retry, every configured gate must have a
higher attempt, a distinct evidence path, and the current generation. Caller
timestamps remain metadata, not freshness proof. A
live pane, existing report, mismatched binding, missing user authority, changed
HEAD, or dirty worktree fails closed. An exact retry is idempotent and returns
`recovered: true`.

Reviewer attempt identity is indexed for the active ticket and keyed by round,
axis, and attempt. The index canonicalizes `state_path`, ignores artifacts for
historical tickets, and serializes its scan through artifact creation under the
run-state lock. The caller cannot reuse an attempt with another path or skip its
exact immediately preceding artifact. An integration cycle is independent of
the review round: interrupted attempts remain bound to their reviewed HEAD,
base SHA, and range. When the ticket has an `Integration` record, gate evidence
binds its current cycle, including after migration recovery; timestamps do not
substitute for that binding. Ordinary malformed-report or infrastructure
retries continue to require the same reviewer role and the same gate evidence.

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

## `agreements.update`

Replace the repository's cross-run agreements: the merge order of run
prefixes and shared-file assignments. A downstream multi-run coordinator calls
it with its own RESUME.md:

```json
{
  "schema_version": 1,
  "operation": "agreements.update",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "merge_order": ["dcs", "abc"],
    "shared_files": [{ "path": "src/api.ts", "owner_prefix": "dcs" }],
    "transfer_ownership": false,
    "user_authorized": false
  }
}
```

The helper reads the caller's `Run id:` UUID from `state_path` without
modifying that file, resolves the repository's Git common directory from its
folder, and atomically replaces `agreements/<repo-id>.json` under that file's
lock. A missing or malformed id fails with `agreements.run_id_missing`; record
one yourself in the caller-owned RESUME.md. The
input replaces the whole agreement; send every entry that should remain.

The first writer becomes the owner. A later write from another run fails with
`agreements.not_owner`. After explicit user authority, set both
`transfer_ownership` and `user_authorized` to `true` to move ownership to the
caller. A transfer without `user_authorized: true` is an invalid request.
A run folder outside Git fails with `agreements.repository_unresolved`.

The result contains the written `path`, the complete `agreements` file, and
`previous_owner_run_id` (null for the first write). The file schema is
[schemas/agreements.v1.schema.json](schemas/agreements.v1.schema.json).
