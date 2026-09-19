# RESUME.md format

`<run>/RESUME.md` is the **only** state file for a run. Every preference the
coordinator or its workers depend on lives here, so a successor session can
reconstruct any launch line without the conversation that produced it.

The current format is schema version 1. The helper's `state.validate` operation
validates only the explicit version marker. Snapshot operations additionally
validate their managed `## Snapshot` JSON record before the coordinator
interprets the remaining fields. Missing, malformed, duplicate, and unsupported
versions fail without automatic migration. After that mechanical check, the
coordinator validates the remaining fields against this template. Fix any
mismatch by hand. See [helper-cli.md](helper-cli.md#statevalidate) for the JSON
operation contract.

## Template

The fence below is `text`, not `markdown`, so the formatter leaves the nested
indentation alone. The indentation is part of the format.

````text
# <slug> implementation run

Schema version: 1

Prefix:          dcs
Base:            main
Base sha:        0123456789abcdef0123456789abcdef01234567
Mode:            parallel
Parallel cap:    3
Branch template: <prefix>-NN-<slug>

Coordinator:
  harness:    claude
  model:      fable
  effort:     low
  handoff:    disabled
  threshold:  unavailable
  unattended: block

Implementor:
  harness: claude
  model:   opus
  effort:  high

Reviewer:
  harness: claude
  model:   sonnet
  effort:  medium

Coordinator ownership:
  generation: 0
  pane: wJE:p1
  harness: claude
  model: fable
  effort: low
  readiness: ready
  marker: coordinator-ready-0-wJE:p1

## Repository policy

```json
{
  "instruction_files": ["CLAUDE.md"],
  "worktree": {
    "kind": "native",
    "tool": "git",
    "root": "/worktrees/example",
    "create_argv": null
  },
  "branch_naming": "<prefix>-NN-<slug>",
  "setup_argvs": [],
  "cleanup": "native-safe",
  "remote": "local-only",
  "remote_sync_argv": null,
  "commit": {
    "commits": "multiple",
    "fixes": "append"
  }
}
```

## Review policy

```json
{
  "instruction_files": ["CLAUDE.md"],
  "ci_files": [".github/workflows/ci.yml"],
  "gates": [
    { "name": "format", "argv": ["bun", "run", "format:check"] },
    { "name": "test", "argv": ["bun", "test"] }
  ],
  "no_executable_gates": false,
  "safety_constraints": ["Do not push."],
  "no_additional_safety_constraints": false,
  "gate_execution": {
    "claude": "background-allowed",
    "pi": "synchronous"
  },
  "self_review": "matt-implement",
  "max_infrastructure_attempts": 4,
  "retry_delays_seconds": [1, 2, 4]
}
```

## Tickets

| NN  | harness | model         | effort | rounds | esc | status  | sha     |
| --- | ------- | ------------- | ------ | ------ | --- | ------- | ------- |
| 01  | claude  | claude-opus-5 | high   | 1      | -   | landed  | a1b2c3d |
| 02  | claude  | claude-opus-5 | high   | 0      | -   | working | -       |
| 03  | claude  | claude-opus-5 | high   | 0      | -   | review  | -       |
| 04  | -       | -             | -      | -      | -   | queued  | -       |

## Active tickets

### 02

Worktree: <policy-created-worktree-path-02>
Branch: <policy-created-branch-02>
Implementor: {"harness":"claude","model":"opus","effort":"high"}
Implement skill: /implement
Session: dcs-02
Tab: implement dcs 02 api
Pane: <herdr-pane-id-02>
Artifact: <absolute-run-path>/briefs/launch-02.json
Attempt: 1
Retry: 0 of 3
Phase: working
Last diagnostic: none

### 03

Worktree: <policy-created-worktree-path-03>
Branch: <policy-created-branch-03>
Implementor: {"harness":"claude","model":"opus","effort":"high"}
Implement skill: /implement
Session: dcs-03
Tab: implement dcs 03 ui
Pane: <herdr-pane-id-03>
Artifact: <absolute-run-path>/briefs/launch-03.json
Attempt: 1
Retry: 0 of 3
Phase: committed, awaiting review
Last diagnostic: none

## Snapshot

```json
{
  "revision": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "accepted_at": "2026-09-11T14:30:00Z",
  "source": {
    "kind": "local",
    "tracker": "local-files",
    "reference": "file:.scratch/example",
    "tracker_workflow": null
  },
  "writeback": "none",
  "inputs": [
    {
      "path": "snapshot.json",
      "source_reference": "file:.scratch/example",
      "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ]
}
```

## Serialized finalization

```json
{
  "ticket": "03",
  "cycle": 0,
  "phase": "gates",
  "base_branch": "main",
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "ticket_sha": "89abcdef0123456789abcdef0123456789abcdef",
  "review_range": "0123456789abcdef0123456789abcdef01234567..89abcdef0123456789abcdef0123456789abcdef",
  "commit_count": 2,
  "commit_policy": { "commits": "multiple", "fixes": "append" },
  "remote_sync_argv": null,
  "conflicts": [],
  "previous_ticket_sha": null,
  "standards_evidence_path": null,
  "spec_evidence_path": null,
  "self_review_path": null,
  "completed_at": "2026-09-11T15:00:00Z"
}
```

## Review evidence

- Ticket 01 round 0 standards attempt 1: accepted; reviewer {"harness":"claude","model":"sonnet","effort":"medium"}; report /run/reviews/01-round-0-standards-attempt-1.md
- Ticket 01 round 0 spec attempt 1: accepted; reviewer {"harness":"claude","model":"sonnet","effort":"medium"}; report /run/reviews/01-round-0-spec-attempt-1.md
- Ticket 01 round 0 finalized: PASS; self-review /run/reviews/01-round-0-self-review.md; Standards /run/reviews/01-round-0-standards-attempt-1.md; Spec /run/reviews/01-round-0-spec-attempt-1.md

## Landed evidence

- Ticket 01: /run/reviews/01-landed.json; tip a1b2c3d; branch dcs-01-schema; cleanup native-safe

## Decisions

- 2026-09-11 snapshot revision sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef accepted (initial; writeback: none)
- 2026-09-11 implementor -> claude fable / low (selected for the remaining UI
  tickets)

## Retained landed branches

- dcs-01-schema (a1b2c3d) (retained by repository cleanup policy)

## Closed ticket runtimes

## Run outcome

```json
{
  "status": "active",
  "completed_at": null,
  "summary_path": null,
  "landed_tickets": ["01"],
  "blocked_tickets": [],
  "closed_tickets": [],
  "runnable_tickets": ["04"],
  "tracker_action": {
    "mode": "none",
    "status": "not-applicable",
    "workflow": null
  }
}
```
````

## Field reference

### Run header

| Field             | Meaning                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Prefix`          | Short run tag; names sessions, tabs, and the pane label                                                                                                             |
| `Base`            | Integration branch. Recorded on first run; **the file always wins** over a later `--base` flag, because changing the base mid-run invalidates every unlanded branch |
| `Base sha`        | Last observed full commit id of `Base`. Update after every landing and when a resume or progress tick observes external movement                                    |
| `Mode`            | `parallel` or `serial`. Controls only which queued tickets start; it does not terminate active workers                                                              |
| `Parallel cap`    | Positive maximum active implementors; exactly `1` in serial mode                                                                                                    |
| `Branch template` | Branch pattern resolved from repository instructions, or `<prefix>-NN-<slug>` when the repository is silent                                                         |

`Base` is the one field where the file beats the flag. `Implementor` and `Mode`
are the opposite (see below). The asymmetry is deliberate: a model or scheduler
preference is cheap to change between ticket launches, a base is not.

A first run requires either `--serial` or `--parallel <N>` with a positive
integer. Persist both fields before launching. On resume, the file wins when no
scheduling flag is present. An explicit flag updates both fields and appends a
decision before more tickets start. Reject both flags together. Switching to
serial records cap 1 but never kills existing parallel workers: stop launching,
drain the active set, then continue one at a time. Raising a parallel cap fills
new capacity at the next `scheduler.plan` pass.

### `## Repository policy`

Managed by `worktree.prepare` before the first worktree is created. The JSON
record names every repository instruction consulted and the resolved worktree,
branch, setup, cleanup, remote, and commit policies. Repository instructions
win over portable defaults.

When no lifecycle tool is prescribed, `worktree.kind` is `native`, `tool` is
`git`, and `root` is the worktree root selected during setup. When a tool is
prescribed, `kind` is `repository`, `tool` names the required executable, and
`create_argv` preserves its exact argument array. An unavailable prescribed
tool is an error, not permission to change `kind`.

When commit instructions are absent, `commit.commits` is `multiple` and
`commit.fixes` is `append`. `remote: local-only` means no fetch or other network
synchronization is assumed.

### `## Review policy`

Managed by `review.policy.prepare` before any active ticket exists. It records
the exact gate argv arrays, the repository instruction and CI sources that
authorized them, and resolved project safety constraints. Empty gates and empty
safety constraints require explicit `no_*` declarations, so missing discovery
cannot masquerade as a completed policy.

The policy fixes four total infrastructure attempts (the initial attempt plus
three retries) and bounded delays of one, two, and four seconds. Claude may
use its supported background command facility for long gates; Pi is always
synchronous through its normal shell tool. `self_review` is the run-wide default
for future implementors, while round finalization validates against the role
actually bound to the ticket.

### `Coordinator:`

Written before any role launches. With Herdr 0.9.1, a change to harness, model,
or effort requires the prior coordinator to end and a replacement invocation
to start with the selected record. It is never a state-only rewrite.

| Field        | Values                | Notes                                                   |
| ------------ | --------------------- | ------------------------------------------------------- |
| `harness`    | `claude` \| `pi`      | Selected from installed harness discovery               |
| `model`      | model id              | Validated against the selected harness                  |
| `effort`     | discovered vocabulary | Validated against installed harness help                |
| `handoff`    | `disabled`            | Herdr 0.9.1 has no normalized context metrics           |
| `threshold`  | `unavailable`         | Prevents rendered terminal text from becoming a trigger |
| `unattended` | `block` \| `escalate` | Governs the fix-round-3 escalation and nothing else     |

`unattended: block` marks a ticket needing escalation as blocked-on-decision,
logs it, and starts the next unblocked ticket. `unattended: escalate`
pre-authorizes the escalation. Neither value affects `TICKET BLOCKED`
questions, scope decisions, or an invalid-record prompt: those always wait for
the user.

### `Implementor:` and `Reviewer:`

These are run-wide defaults for future launches. An active implementor keeps
the record copied into its ticket row. A review records the Reviewer default it
bound when that review session launched. Changing either default never restarts
an active session.

| Field     | Values                | Notes                                              |
| --------- | --------------------- | -------------------------------------------------- |
| `harness` | `claude` \| `pi`      | Selected explicitly, never inferred from the model |
| `model`   | model id              | Validated against the selected installed harness   |
| `effort`  | discovered vocabulary | Harness-scoped and read from installed help        |

Inside each `## Active tickets` runtime block, `Implementor:` is compact JSON
with exactly `harness`, `model`, and `effort` fields. This representation is the
ticket-bound role used for recovery. The helper parses it structurally and
preserves the model string byte-for-byte, including spaces. It never reconstructs
a role by splitting display text.

The `implement` skill is a fixed workflow requirement, not a configurable role
field. Its actual Pi path is recorded in each launch artifact.

### `Coordinator ownership:`

Ownership is separate from the selected Coordinator role. The role says what
must run; ownership says which Herdr pane currently coordinates the run.

| Field                   | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `generation`            | Monotonically increasing compare-and-swap generation                        |
| `pane`                  | Current coordinator Herdr pane id                                           |
| `harness`               | Harness bound to the owner, updated from the claimed successor role         |
| `model`                 | Model bound to the current owner                                            |
| `effort`                | Effort bound to the current owner                                           |
| `readiness`             | `claiming` until the successor has resumed and armed its wait, then `ready` |
| `marker`                | Generation-specific marker the predecessor must observe in that pane        |
| `predecessor pane`      | Legacy automatic handoff predecessor authorized for close verification      |
| `handoff artifact hash` | SHA-256 binding to an exact legacy automatic handoff artifact               |

Initial role mismatch or process-replacement takeover uses `coordinator.claim`
followed by `coordinator.ready`. New Herdr 0.9.1 runs do not create automatic
handoff artifacts or write the two legacy predecessor fields. Existing legacy
state that already contains them remains structurally valid for recovery.

### Ticket table

One row per ticket, written when the ticket starts and updated as it moves.
Each row is **self-contained**: it repeats the full resolved record rather than
pointing at `Implementor:`, so a successor can relaunch any ticket without
reasoning about when the run-wide record last changed.

| Column                     | Meaning                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `NN`                       | Ticket number                                                                      |
| `harness` `model` `effort` | The role **bound at ticket start**; never rewritten                                |
| `rounds`                   | Fix rounds completed                                                               |
| `esc`                      | `yes` once this ticket escalated past its bound model                              |
| `status`                   | `queued` \| `working` \| `review` \| `fixing` \| `blocked` \| `landed` \| `closed` |
| `sha`                      | Landed sha, or `-` for non-landed terminal work                                    |

### `## Active tickets`

One block per ticket from successful worktree creation until landing. The
heading must be the ticket's zero-padded `NN`, and every block carries these
fields:

| Field             | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `Worktree`        | Actual path returned by `worktree.prepare`                                     |
| `Branch`          | Actual policy-created branch                                                   |
| `Implementor`     | Exact bound harness, model, and effort                                         |
| `Implement skill` | Exact Pi `SKILL.md` path, or Claude's fixed `/implement` invocation            |
| `Session`         | Worker session name, normally `<prefix>-NN`                                    |
| `Tab`             | Herdr tab label                                                                |
| `Pane`            | Current Herdr pane id; refresh it from Herdr after resume                      |
| `Artifact`        | Absolute path to the inspectable JSON argument-array launch artifact           |
| `Attempt`         | Current one-based launch attempt, from initial attempt 1 through final retry 4 |
| `Retry`           | Completed retries and fixed maximum, always `0 of 3` through `3 of 3`          |
| `Phase`           | `launch prepared`, `working`, `launch failed`, or the later workflow phase     |
| `Last diagnostic` | `none` or the exact failing stage, exit code, and normalized stderr            |

An operator-authorized compatibility recovery adds these fields without
rewriting the attempt, retry count, or last failure diagnostic:

| Field                    | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `Recovery authorization` | `user`, proving the transition was explicitly authorized    |
| `Recovery cause`         | Fixed `coordinator compatibility defect` classification     |
| `Recovery diagnostic`    | Exact single-line compatibility failure confirmed by user   |
| `Recovered at`           | Whole-second UTC timestamp for the atomic recovery mutation |

The ticket table remains the scheduler's source of truth. The active block is
runtime coordination state. Create it before launch, update it at every phase
change and progress tick, and remove it only after the ticket lands. Every row
with status `working`, `review`, or `fixing` must have a matching block. A
`blocked` row keeps its block when a worktree already exists. When the user
explicitly closes that work at run finalization, `run.finalize` moves the block
to `## Closed ticket runtimes` and adds `Closed at:` and `Close reason:` fields.
This preserves the bound role, branch, worktree, retries, and last diagnostic
without misrepresenting it as an active session.

### `## Snapshot`

Managed by the helper's `snapshot.accept` operation. It records the accepted
snapshot revision, acceptance time, durable source metadata, tracker writeback
mode, and the sorted path, source-reference, and SHA-256 list. The coordinator
must not schedule or review when `snapshot.check` reports `unaccepted` or
`changed`.

For local-file sources, `source.kind` is `local`, `tracker_workflow` is null,
and writeback is `none`. Non-local sources persist an opaque configured Matt
tracker workflow and one of `none`, `final`, or `live`. Project policy that
forbids remote writes overrides `final` and `live`. See
[normalized-snapshot.md](normalized-snapshot.md) for the manifest, acceptance,
and revision rules.

### `## Serialized finalization`

A transient helper-owned JSON record exists from `landing.synchronize` until
`landing.complete` durably records success. It is the single slot that
serializes synchronization, final gates, review, and landing while other
implementors continue. The record binds the ticket, local base and ticket tips,
full review range, commit policy, optional authorized remote command, conflict
paths, recovery cycle, and final review evidence.

`review.round.finalize` advances a passing record to `ready-to-land`. A failed
review records `fixing` and the prior tip used to enforce append-only fixes. A
refused fast-forward records `resynchronize` and clears stale final-review
paths. Scope conflicts may remain `awaiting-user`. Never clear or transfer this
record by hand merely to admit another ticket.

### `## Review evidence`

Append-only review provenance. Each reviewer attempt records ticket, round,
axis, attempt, status, the exact bound Reviewer role, and the run-local report
path. Round finalization adds the implementor self-review and both accepted axis
report references. Complete Markdown reports and JSON sidecars remain under the
run directory across every fix round. Contaminated and malformed attempts stay
in this history and are never replaced by later accepted attempts.

### `## Landed evidence`

Append-only references to immutable JSON written by `landing.complete`. Each
file binds the full landed tip, local base SHA, retained branch, final Standards,
Spec, and self-review paths, Herdr-observed runtime closure, exact cleanup argv,
cleanup result, and completion time. Caller-supplied closure assertions are not
accepted. The helper writes this evidence and updates ticket state before
returning `schedule`.

### `## Decisions`

Append-only, dated. The record above is overwritten in place so it always
states what is current; this section states what changed and why. Every
snapshot acceptance, tracker-policy change, preference change, scope decision,
escalation, and explicit blocked-ticket closure appends a line.

### `## Run outcome`

Managed by `run.finalize`. `status` is `active`, `waiting`, or `completed`.
`waiting` means no implementor is active and the dependency graph has no
runnable queued ticket, but blocked or dependency-blocked work remains. It is
not success. `completed` is valid only when every table row is `landed` or
`closed`; it records the immutable run-local SUMMARY.md path and completion
time. The ticket arrays and runnable frontier are sorted and make downstream
reads deterministic.

`tracker_action` repeats the persisted snapshot writeback mode and reports
`not-applicable`, `pending`, or `forbidden`. A pending `final` or `live` action
names the opaque Matt tracker workflow. The run summary is local and remains
required regardless of remote-write policy or tracker availability.

## Harness vocabulary

Run `roles.discover` before presenting choices and validate every role write
with `role.validate`. The table explains launch syntax, but installed helper
output is authoritative for models and effort values. The harnesses do **not**
validate for you: `claude --effort bogus` can warn and silently use a default,
which is the exact substitution this skill forbids.

| Harness  | Model form            | Effort flag  | Required implement launch                | Permission flag                   |
| -------- | --------------------- | ------------ | ---------------------------------------- | --------------------------------- |
| `claude` | alias or custom value | `--effort`   | Prompt begins `/implement`               | `--permission-mode auto`          |
| `pi`     | `<provider>/<model>`  | `--thinking` | `--skill <path>` plus `/skill:implement` | `--approve` for new role sessions |

Never pass a non-Anthropic model to `claude`.

### Model form, and the `:<level>` suffix

**`pi` requires a provider prefix**: `openai-codex/gpt-5.6-sol`, never a bare
`gpt-5.6-sol`. **`claude` takes the model alone**: `claude-opus-5`, never a
provider prefix.

Either harness's `model:` field may carry an optional **`:<level>` suffix**:
`openai-codex/gpt-5.6-sol:low`, `claude-opus-5:high`. That suffix is _record
notation_, and it exists because a human may type it. **Always split it and emit
the harness's own effort flag.** Never pass a colon through to either CLI:

```
model: openai-codex/gpt-5.6-sol:low   ->  pi --model openai-codex/gpt-5.6-sol --thinking low
model: claude-opus-5:high             ->  claude --model claude-opus-5 --effort high
```

Note the split point is the **last** colon, and only when what follows it is an
effort value for that harness. A provider prefix uses `/`, so
`openai-codex/gpt-5.6-sol` has no colon to confuse it, but do not assume a model
id can never contain one.

When a record carries both a suffix and a separate `effort:` field, the two must
agree. If they disagree the record is malformed: stop and ask rather than
picking one. Prefer writing the split form (`model:` plus `effort:`) when you
author a record yourself.

### Two pi facts that bite

- **pi has no `--permission-mode`.** `--approve` trusts project-local files for
  the run, which is a different concern. Omit any permission-mode flag and pass
  `--approve` when launching a new Pi role session so unattended project
  resources do not stall. (Checked against pi 0.85.1.)
- **Read the vocabulary off the installed pi, not off this table.** pi's
  `--thinking` levels and model catalog are version-specific. When a record
  looks invalid, run `pi --version`, `pi --help`, and `pi --list-models` before
  concluding it is wrong; the installed pi may simply be behind.

### Reject only after checking the installed harness

An effort value or model that this table does not list may mean the record is
wrong, or may mean the installed harness differs from the version documented
here. Distinguish them before stopping a ticket: inspect the harness version,
help, and model catalog.

Every implementor loads the fixed `implement` skill before its prose prompt.
Claude prompts begin with `/implement`. Pi receives both
`--skill <path-to-implement/SKILL.md>` and a `/skill:implement` prompt prefix,
plus `--approve` for project-local resources. The skill is intentionally
user-invoked and may be absent from model discovery; its explicit path and
prefix are authoritative.

## Validation

### At write time

Resolve all three role records in one setup interaction, validate each through
`role.validate`, and persist Coordinator, Implementor, and Reviewer before any
session launch. Reject and ask the user rather than writing a record that
cannot launch:

- `Mode` is not exactly `parallel` or `serial`, `Parallel cap` is not positive,
  or serial mode does not use cap 1.
- `Base sha` is not a full commit id.
- an active ticket lacks its required runtime block or the block names a
  missing worktree, branch, launch artifact, attempt, retry state, or pane.
- `effort` is not accepted by the installed harness.
- `model` is non-Anthropic while `harness` is `claude`.
- `model` lacks a `<provider>/` prefix while `harness` is `pi`, or carries one
  while `harness` is `claude`.
- a `:<level>` suffix disagrees with the record's own `effort:` field.
- `Coordinator.handoff` and `Coordinator.threshold` are not the exact
  `disabled` and `unavailable` pair for a new Herdr 0.9.1 run.
- `Coordinator ownership` is missing, malformed, lacks its bound role record,
  or names the invoking pane as a successor claim.
- repository policy is absent before worktree creation.
- review policy is absent, unresolved, or was prepared after worker launch.
- a prescribed worktree tool is unavailable.
- Pi's explicit `implement` skill path is absent or not a file.

Never reject a record because `implement` is absent from model discovery. It is
required, user-invoked, and explicitly loaded at launch.

**A harness change re-validates the entire record**, not just the changed
field. Effort vocabulary, model form, and the launch adapter are harness-scoped.

### At launch time

A session that fails to start stops that ticket and is reported with its
output. Never substitute a default model, effort, harness, worktree tool, or
required skill to keep the run moving.

### On read

A successor first invokes the helper's `state.validate` operation. A missing,
malformed, duplicate, or unsupported `Schema version:` marker stops the resume
without migration or mutation. After that mechanical check, the successor
validates the whole file against this template before acting. Any mismatch
stops the resume with an explanation.
