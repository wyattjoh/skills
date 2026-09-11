# RESUME.md format

`<run>/RESUME.md` is the **only** state file for a run. Every preference the
coordinator or its workers depend on lives here, so a successor session can
reconstruct any launch line without the conversation that produced it.

There is no format version and no migration path. A RESUME.md that does not
match this template fails validation on read; fix it by hand.

## Template

The fence below is `text`, not `markdown`, so the formatter leaves the nested
indentation alone. The indentation is part of the format.

```text
# <slug> implementation run

Prefix: dcs
Base:   main

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
| 03  | -       | -             | -      | -         | -      | -   | queued  | -       |

## Decisions

- 2026-09-11 implementor -> claude-fable-5-1 / low (opus overkill for the
  remaining UI tickets)

## Landed, not deleted

- wyattjoh/dcs-01-schema (a1b2c3d)
```

## Field reference

### Run header

| Field    | Meaning                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Prefix` | Short run tag; names branches, sessions, tabs, and the pane label                                                                                                   |
| `Base`   | Integration branch. Recorded on first run; **the file always wins** over a later `--base` flag, because changing the base mid-run invalidates every unlanded branch |

`Base` is the one field where the file beats the flag. `Implementor` is the
opposite (see below). The asymmetry is deliberate: a model is cheap to change
between tickets, a base is not.

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

| Field     | Values               | Notes                                                  |
| --------- | -------------------- | ------------------------------------------------------ |
| `harness` | `claude` \| `pi`     | Resolved from the model at record time, then persisted |
| `model`   | model id             |                                                        |
| `effort`  | see vocabulary table | Harness-scoped                                         |
| `skills`  | ordered list         | Rendered into the worker prompt prefix, harness-scoped |

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

### `## Decisions`

Append-only, dated. The record above is overwritten in place so it always
states what is current; this section states what changed and why. Every
preference change, scope decision, and escalation appends a line.

## Harness vocabulary

Validate every write against this table. The harnesses do **not** validate for
you: `claude --effort bogus` prints a warning and silently runs at the default
effort, which is the exact silent substitution this skill forbids.

| Harness  | Launch                | Effort flag  | Effort values                                       | Skill prefix     | Skill source                        |
| -------- | --------------------- | ------------ | --------------------------------------------------- | ---------------- | ----------------------------------- |
| `claude` | Anthropic models only | `--effort`   | `low` `medium` `high` `xhigh` `max`                 | `/<skill>`       | `~/.claude/skills/`, project skills |
| `pi`     | any model             | `--thinking` | `off` `minimal` `low` `medium` `high` `xhigh` `max` | `/skill:<skill>` | discovered, or `--skill <path>`     |

Never pass a non-Anthropic model to `claude`.

A skills list renders into the worker prompt as the prefix, in order:

```
claude   skills: [implement, codebase-design]  ->  /implement /codebase-design <prompt>
pi       skills: [implement, codebase-design]  ->  /skill:implement /skill:codebase-design <prompt>
```

## Validation

### At write time

Reject and ask the user rather than writing a record that cannot launch:

- `effort` is not in the harness's vocabulary.
- `model` is non-Anthropic while `harness` is `claude`.
- a named skill is not available in that harness.

**A harness change re-validates the entire record**, not just the changed
field. Effort vocabulary, skill availability, and the prompt prefix are all
harness-scoped, so switching `claude` -> `pi` can invalidate an `effort` and a
`skills` entry that were valid a moment earlier.

### At launch time

A session that fails to start stops that ticket and is reported with its
output. Never substitute a default model, a default effort, or a shorter skills
list to keep the run moving.

### On read

A successor validates the whole file before acting on it. A record that does
not match this template stops the resume with an explanation.
