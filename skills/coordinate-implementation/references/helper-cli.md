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
- `herdr api schema --json` exposes normalized `context_used` and
  `context_limit` fields;
- the optional state document uses supported schema version 1.

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

Use `diagnostic: null` with `status: started`. A later retry increments
`attempt` but keeps the bound harness, model, effort, worktree, branch, and
exact required implement skill path.

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
