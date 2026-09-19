# RESUME.md format

`<run>/RESUME.md` is the **only** state file for a run. Every preference the
coordinator or its workers depend on lives here, so a successor session can
reconstruct any launch line without the conversation that produced it.

The current format is schema version 1. The bundled helper validates only the
explicit version marker before the coordinator interprets any other field.
Missing, malformed, duplicate, and unsupported versions fail without automatic
migration. After that mechanical check, the coordinator validates the remaining
fields against this template. Those semantic checks are not part of the helper's
`state.validate` operation in this ticket. Fix any mismatch by hand. See
[helper-cli.md](helper-cli.md#statevalidate) for the JSON operation contract.

## Template

The fence below is `text`, not `markdown`, so the formatter leaves the nested
indentation alone. The indentation is part of the format.

```text
# <slug> implementation run

Schema version: 1

Prefix:          dcs
Base:            main
Base sha:        0123456789abcdef0123456789abcdef01234567
Mode:            parallel
Branch template: <prefix>-NN-<slug>

Coordinator:
  harness:    claude
  model:      claude-fable-5-1
  effort:     low
  handoff:    yes
  threshold:  200000
  unattended: block

Implementor:
  harness: claude
  model:   claude-opus-5
  effort:  high
  skills:  [implement]

## Tickets

| NN  | harness | model         | effort | skills    | rounds | esc | status  | sha     |
| --- | ------- | ------------- | ------ | --------- | ------ | --- | ------- | ------- |
| 01  | claude  | claude-opus-5 | high   | implement | 1      | -   | landed  | a1b2c3d |
| 02  | claude  | claude-opus-5 | high   | implement | 0      | -   | working | -       |
| 03  | claude  | claude-opus-5 | high   | implement | 0      | -   | review  | -       |
| 04  | -       | -             | -      | -         | -      | -   | queued  | -       |

## Active tickets

### 02

Worktree: <generated-worktree-path-02>
Branch: <generated-branch-02>
Session: dcs-02
Tab: claude dcs 02 api
Pane: <herdr-pane-id-02>
Phase: editing
Launch: briefs/launch-02.sh
Monitor: armed

### 03

Worktree: <generated-worktree-path-03>
Branch: <generated-branch-03>
Session: dcs-03
Tab: claude dcs 03 ui
Pane: <herdr-pane-id-03>
Phase: committed, awaiting review
Launch: briefs/launch-03.sh
Monitor: settled

## Decisions

- 2026-09-11 implementor -> claude-fable-5-1 / low (opus overkill for the
  remaining UI tickets)

## Retained landed branches (Pi)

- dcs-01-schema (a1b2c3d) (Pi/Pando retained this branch)
```

## Field reference

### Run header

| Field             | Meaning                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Prefix`          | Short run tag; names sessions, tabs, and the pane label                                                                                                             |
| `Base`            | Integration branch. Recorded on first run; **the file always wins** over a later `--base` flag, because changing the base mid-run invalidates every unlanded branch |
| `Base sha`        | Last observed full commit id of `Base`. Update after every landing and when a resume or progress tick observes external movement                                    |
| `Mode`            | `parallel` (default) or `serial`. Controls only which queued tickets start; it does not terminate active workers                                                    |
| `Branch template` | Pi branch pattern. Supports `<prefix>`, `NN`, and `<slug>`. Resolve from repository instructions, or use `<prefix>-NN-<slug>` when none exists                      |

`Base` is the one field where the file beats the flag. `Implementor` and `Mode`
are the opposite (see below). The asymmetry is deliberate: a model or scheduler
preference is cheap to change between ticket launches, a base is not.

On a first run, write `Mode: parallel` unless `--serial` was passed. On resume,
the file wins when neither scheduling flag is present. An explicit `--serial`
or `--parallel` updates the field and appends a decision before more tickets
start. Reject both flags together. Switching to `serial` never kills existing
parallel workers: stop launching, drain the active set, then continue one at a
time. Switching to `parallel` starts every unblocked queued ticket at the next
scheduler pass.

### `Coordinator:`

Written on first run and inherited verbatim by every successor.

| Field        | Values                | Notes                                                                |
| ------------ | --------------------- | -------------------------------------------------------------------- |
| `harness`    | `claude` \| `pi`      | Introspected on first run                                            |
| `model`      | model id              | Introspected on first run                                            |
| `effort`     | see vocabulary table  | Cannot be introspected; asked on first run, default `low`            |
| `handoff`    | `yes` \| `no`         | Default follows harness: `claude` -> `yes`, `pi` -> `no`             |
| `threshold`  | token count           | Default `200000`. Scheduled prompts read it from here, never inline  |
| `unattended` | `block` \| `escalate` | Default `block`. Governs the fix-round-3 escalation and nothing else |

`unattended: block` marks a ticket needing escalation as blocked-on-decision,
logs it, and starts the next unblocked ticket. `unattended: escalate`
pre-authorizes the escalation. Neither value affects `TICKET BLOCKED`
questions, scope decisions, or an invalid-record prompt: those always wait for
the user.

### `Implementor:`

The run-wide record. It governs the **next ticket to start** and nothing that
is already running.

| Field     | Values               | Notes                                                                               |
| --------- | -------------------- | ----------------------------------------------------------------------------------- |
| `harness` | `claude` \| `pi`     | Resolved from the model at record time, then persisted                              |
| `model`   | model id             |                                                                                     |
| `effort`  | see vocabulary table | Harness-scoped                                                                      |
| `skills`  | ordered list         | Must begin with `implement`; rendered into the worker prompt prefix, harness-scoped |

### Ticket table

One row per ticket, written when the ticket starts and updated as it moves.
Each row is **self-contained**: it repeats the full resolved record rather than
pointing at `Implementor:`, so a successor can relaunch any ticket without
reasoning about when the run-wide record last changed.

| Column                              | Meaning                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `NN`                                | Ticket number                                                          |
| `harness` `model` `effort` `skills` | The record **bound at ticket start**; never rewritten                  |
| `rounds`                            | Fix rounds completed                                                   |
| `esc`                               | `yes` once this ticket escalated past its bound model                  |
| `status`                            | `queued` \| `working` \| `review` \| `fixing` \| `blocked` \| `landed` |
| `sha`                               | Landed sha                                                             |

### `## Active tickets`

One block per ticket from successful worktree creation until landing. The
heading must be the ticket's zero-padded `NN`, and every block carries these
fields:

| Field      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `Worktree` | Actual path returned by the coordinator harness                                         |
| `Branch`   | Actual branch returned by the coordinator harness                                       |
| `Session`  | Worker session name, normally `<prefix>-NN`                                             |
| `Tab`      | Herdr tab label                                                                         |
| `Pane`     | Current herdr pane id; refresh it from `herdr pane list` after resume                   |
| `Phase`    | Precise human-readable activity, such as `editing`, `fix round 2`, or `awaiting review` |
| `Launch`   | Run-relative path to the exact launch script                                            |
| `Monitor`  | `armed`, `settled`, or `not-armed`, updated whenever the monitor changes                |

The ticket table remains the scheduler's source of truth. The active block is
runtime coordination state. Create it before launch, update it at every phase
change and progress tick, and remove it only after the ticket lands. Every row
with status `working`, `review`, or `fixing` must have a matching block. A
`blocked` row keeps its block when a worktree already exists.

### `## Decisions`

Append-only, dated. The record above is overwritten in place so it always
states what is current; this section states what changed and why. Every
preference change, scope decision, and escalation appends a line.

## Harness vocabulary

Validate every write against this table. The harnesses do **not** validate for
you: `claude --effort bogus` prints a warning and silently runs at the default
effort, which is the exact silent substitution this skill forbids.

| Harness  | Model form           | Effort flag  | Effort values                                       | Skill prefix     | Skill source                        | Permission flag          |
| -------- | -------------------- | ------------ | --------------------------------------------------- | ---------------- | ----------------------------------- | ------------------------ |
| `claude` | `<model>`            | `--effort`   | `low` `medium` `high` `xhigh` `max`                 | `/<skill>`       | `~/.claude/skills/`, project skills | `--permission-mode auto` |
| `pi`     | `<provider>/<model>` | `--thinking` | `off` `minimal` `low` `medium` `high` `xhigh` `max` | `/skill:<skill>` | `--skill <path>`, or discovered     | **none — omit it**       |

Never pass a non-Anthropic model to `claude`.

### Model form, and the `:<level>` suffix

**`pi` requires a provider prefix** — `openai-codex/gpt-5.6-sol`, never a bare
`gpt-5.6-sol`. **`claude` takes the model alone** — `claude-opus-5`, never a
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
effort value for that harness — a provider prefix uses `/`, so
`openai-codex/gpt-5.6-sol` has no colon to confuse it, but do not assume a model
id can never contain one.

When a record carries both a suffix and a separate `effort:` field, the two must
agree. If they disagree the record is malformed: stop and ask rather than
picking one. Prefer writing the split form (`model:` plus `effort:`) when you
author a record yourself.

### Two pi facts that bite

- **pi has no `--permission-mode`.** Its whole flag surface offers only
  `--approve` ("Trust project-local files for this run"), which is a different
  thing. **Omit the permission flag from every pi launch line**; do not
  substitute `--approve` for it. (Checked against pi 0.85.1.)
- **Read the vocabulary off the installed pi, not off this table.** pi's
  `--thinking` levels and model catalog are version-specific. When a record
  looks invalid, run `pi --version`, `pi --help`, and `pi --list-models` before
  concluding it is wrong; the installed pi may simply be behind.

### Reject only after checking the installed harness

An effort value or model that this table does not list may mean the record is
wrong, or may mean the installed harness differs from the version documented
here. Distinguish them before stopping a ticket: inspect the harness version,
help, and model catalog.

Every worker skills list must begin with `implement`. Render the whole list into
the worker prompt as a prefix, in order, before any prose:

```
claude   skills: [implement, codebase-design]  ->  /implement /codebase-design <prompt>
pi       skills: [implement, codebase-design]  ->  /skill:implement /skill:codebase-design <prompt>
```

`implement` is intentionally user-invoked and has
`disable-model-invocation: true`. It may therefore be absent from a harness's
model-discoverable or automatically invocable skill listing. That absence is
expected and is never a validation failure. Do not check discovery to decide
whether `implement` can be used. Its explicit first-position prefix is the
invocation.

Additional skills after `implement` are different: validate that each is
available to the selected harness and preserve their recorded order.

## Validation

### At write time

Reject and ask the user rather than writing a record that cannot launch:

- `Mode` is not exactly `parallel` or `serial`.
- `Base sha` is not a full commit id.
- an active ticket lacks its required runtime block or the block names a
  missing worktree, branch, launch script, or pane.
- `effort` is not accepted by the installed harness.
- `model` is non-Anthropic while `harness` is `claude`.
- `model` lacks a `<provider>/` prefix while `harness` is `pi`, or carries one
  while `harness` is `claude`.
- a `:<level>` suffix disagrees with the record's own `effort:` field.
- the `skills` list does not begin with `implement`.
- a skill after `implement` is not available in that harness.

Never reject a record because `implement` is absent from skill discovery. It is
required, user-invoked, and explicitly prefixed at launch.

**A harness change re-validates the entire record**, not just the changed
field. Effort vocabulary, additional-skill availability, and the prompt prefix
are harness-scoped, so switching `claude` -> `pi` can invalidate an `effort` or
an additional `skills` entry that was valid a moment earlier. `implement`
remains required and exempt from discovery checks in both harnesses.

### At launch time

A session that fails to start stops that ticket and is reported with its
output. Never substitute a default model, a default effort, or a shorter skills
list to keep the run moving.

### On read

A successor first invokes the helper's `state.validate` operation. A missing,
malformed, duplicate, or unsupported `Schema version:` marker stops the resume
without migration or mutation. After that mechanical check, the successor
validates the whole file against this template before acting. Any mismatch
stops the resume with an explanation.
