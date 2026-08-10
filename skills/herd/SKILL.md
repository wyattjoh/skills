---
name: herd
description: >-
  Runs a batch of tickets in parallel as real agent sessions in sibling herdr
  tabs, each in its own worktree, coordinated over cross-session peer messaging.
  Workers self-review against the spec and report back; the coordinator
  serializes merges. Triggers on "herd these tickets", "run these in parallel
  panes", "spin up an agent per ticket", "orchestrate these tickets with herdr",
  "open a pane per task", or "fan these tickets out to separate sessions".
argument-hint: "[tickets-dir | ticket-list] [--target <branch>] [--concurrency N] [--model <model>]"
effort: high
memory: user
disable-model-invocation: true
---

# Herd

Run a batch of tickets in parallel, one real agent session per ticket, each in
its own herdr tab and its own git worktree.

You stay in this session as the **coordinator**. You own the schedule, the
worktrees, the merges, and the conversation with the user. Workers own their
implementation _and their own review loop_ — each spawns its own reviewer
subagent and iterates until that reviewer approves, then reports back to you
once. You never review their work round-by-round; you verify the result.

This differs from `task-orchestrator`, which does the same shape of work with
in-process subagents. Use `herd` when you want the work visible and steerable as
real panes the user can watch, attach to, and interrupt — and when workers
should be able to run under a different agent CLI or a non-Claude model. Use
`task-orchestrator` when in-process subagents are enough.

**Only runs inside herdr.** Check `HERDR_ENV=1` first; stop if it is unset.

## Quick start

1. **Preflight.** Resolve the run context and refuse to start on a broken one:

   ```bash
   bun $SKILL_DIR/scripts/preflight.ts --session-id ${CLAUDE_SESSION_ID}
   ```

   Exit code `1` means one or more problems; surface them and stop. The output
   gives you the workspace to create tabs in, **your own peer name** (workers
   address their reports to it), the repo root, and the live peer list.

2. **Parse the tickets** into `[{ id, title, path, dependsOn }]`. Dependencies
   are explicit only — from `depends-on:` frontmatter or `after #N` notation.
   Never infer an edge silently; propose it at the gate instead.

3. **Confirm** (see [Confirmation gate](#confirmation-gate)). Nothing
   destructive happens before the user approves.

4. **Initialize the roster**, and exclude it from git:

   ```bash
   exclude="$(git rev-parse --git-common-dir)/info/exclude"
   grep -qxF '.herd/' "$exclude" 2>/dev/null || echo '.herd/' >> "$exclude"
   bun $SKILL_DIR/scripts/roster.ts init --repo-root <root> --batch <batch> \
     --tickets <tickets.json> --coordinator-peer <name> --workspace <wsId> \
     --target <branch> --concurrency <n>
   ```

5. **Run the loop** until every ticket is terminal. See
   [references/orchestration-loop.md](references/orchestration-loop.md).

6. **Report**: merged / escalated / blocked, plus retained worktree paths.

If a roster already exists for the batch, you are **resuming** — reconcile
before dispatching anything. Do not start fresh.

## Confirmation gate

Resolve and present all of this before creating a worktree, tab, or branch:

- **Ticket list** with ids, titles, and the dependency DAG.
- **Merge target** — the branch workers' commits land on.
- **Concurrency cap** — simultaneous workers. Default 3.
- **Per-ticket dispatch plan** — for each ticket: the CLI (`claude` or `pi`),
  the agent definition, the model, and the effort. See
  [Choosing how a worker runs](#choosing-how-a-worker-runs).
- **The blast radius, stated plainly**: N unattended sessions will run with
  `--permission-mode auto`, each able to edit files and run commands inside its
  own worktree without prompting.
- **The verification gate** you detected, or that you found none.

Wait for explicit approval. Then run autonomously, surfacing only escalations
and the final report.

## Choosing how a worker runs

Per ticket, in this order:

1. **Match the ticket's intent to an agent definition.** List the candidates:

   ```bash
   bun $SKILL_DIR/scripts/agents.ts --project-root <root>
   ```

   If one matches the ticket's nature, launch with `--agent <name>`.

2. **Take model and effort from that agent's frontmatter.** When the agent
   declares `model` or `effort`, do **not** pass a competing `--model`/`--effort`
   flag — the agent's own configuration is the point. When it omits them, they
   inherit from the launched session's defaults.

3. **When no agent matches**, launch a plain session with whatever the user
   requested, or inherit by default. Omitting `--model`/`--effort` entirely is
   the correct way to inherit; there is no "inherit" value to pass.

`claude --agent <name>` replaces the default Claude Code system prompt
**entirely**. The brief is therefore the worker's only instruction set — see
[The brief](#the-brief).

**Model routes the CLI.** Anything in the `gpt-` family runs under `pi`;
everything else runs under `claude`. `spawn.ts` infers this from `--model`, or
takes `--kind` explicitly. pi advertises itself as a peer via `--claude-peer
--cc-name`, and spells effort `--thinking` (which also accepts `off` and
`minimal`, levels claude rejects).

**"terra", "luna" and "sol" are the operator's names for the gpt-5.6 models.**
A request to "use terra" means `gpt-5.6-terra`, and likewise for
`gpt-5.6-luna` and `gpt-5.6-sol`. Pass any of these — bare alias or full name —
as `--model`; `spawn.ts` expands them to the provider-qualified form pi needs:

| You pass         | pi receives                          |
| ---------------- | ------------------------------------ |
| `terra`          | `--model openai-codex/gpt-5.6-terra` |
| `gpt-5.6-sol`    | `--model openai-codex/gpt-5.6-sol`   |
| `openai-codex/…` | unchanged                            |

The `openai-codex/` prefix is not optional. A bare `gpt-5.6-terra` resolves
against whatever provider the local pi settings default to, so the worker can
silently end up on a different model than the one chosen at the gate.

## The brief

Compose it from [references/worker-brief.md](references/worker-brief.md), write
it to `.herd/<batch>/<ticket-id>/brief.md`, and pass that path to `spawn.ts`.

The brief is the whole contract: identity, boundaries, the inlined spec,
verification commands, the self-review loop, and the exact JSON report format.
Inline the spec verbatim — a worker told to go read its ticket can read the
wrong file or improvise.

`spawn.ts` submits the brief through an argv array, never a shell string, so
quotes, backticks, and newlines in ticket prose survive intact.

## Dispatching a worker

```bash
# 1. Worktree, from the repo root. Capture the path from the JSON.
pando create <branch> --output json

# 2. Tab + agent + brief, as one transaction.
bun $SKILL_DIR/scripts/spawn.ts \
  --workspace <wsId> --label <ticket-id> --cwd <worktree> \
  --peer-name <worker-peer-name> --brief .herd/<batch>/<ticket-id>/brief.md \
  [--agent <name>] [--model <model>] [--effort <level>]
```

`spawn.ts` creates the tab, starts the agent CLI in it, waits for readiness, and
submits the brief. If any step after tab creation fails it closes the tab, so a
failed spawn leaves no orphan pane masquerading as a live worker.

Record `peerName`, `tabId`, `paneId`, `worktree`, `branch`, and the worktree's
starting SHA in the roster **the moment they exist**. They cannot be
reconstructed after a compaction.

Worker peer names come from `workerPeerName(batch, ticketId)` in `preflight.ts`
(`herd-<batch>-<ticket>`). Check the generated name against the `livePeers` list
from preflight before spawning; a collision makes `SendMessage` ambiguous for
the rest of the run.

## Waiting and merging

Workers report **once**, over peer messaging, as a JSON body. That message is
the authoritative completion signal.

Use `herdr pane read` only to diagnose a worker that has gone quiet, never as
the completion signal — it returns wrapped, truncated, TUI-decorated text.
`herdr agent list` / `herdr agent wait` give you `agent_status` for stall
detection; a worker sitting in `blocked` is waiting on a prompt.

On a `done` report: verify the diff yourself, confirm the worker stayed inside
its worktree, run the verification gate, then `cd <worktree> && pando merge`,
`herdr tab close <tabId>`, and re-evaluate the ready set. Merges are serialized
through you, so there is no race on the target branch.

On `blocked`: retain the worktree and the tab, hold dependents blocked, surface
it to the user.

Full state machine, failure modes, escalation rules, and resumption:
[references/orchestration-loop.md](references/orchestration-loop.md).

## Memory

Read `~/.claude/agent-memory/herd/MEMORY.md` at the start of a run, before the
confirmation gate, and fold anything relevant into the dispatch plan. Write to
that directory at the end of a run.

It is cross-project on purpose: what generalizes is how _herding_ behaves, not
what any one repo contains. Worth recording — an agent definition that turned
out to suit (or badly misfit) a class of ticket; a model or effort level that
reliably under- or over-shot; a spawn or peer-messaging failure and its cause;
a ticket shape that should have been split. Not worth recording — anything
recoverable from the repo, the roster, or git history.

One file per fact, plus a one-line pointer in `MEMORY.md`:
`- [file.md](file.md) - hook`. Update an existing file rather than adding a
near-duplicate.

## Scripts

Where `$SKILL_DIR` resolves to `~/.claude/skills/herd/`.

```bash
# Resolve run context; exit 1 when the environment is not ready.
bun $SKILL_DIR/scripts/preflight.ts --session-id <uuid> [--sessions-dir <dir>]

# List launchable agent definitions with their model/effort/memory frontmatter.
bun $SKILL_DIR/scripts/agents.ts [--project-root <dir>] [--user-dir <dir>] [--json]

# Create a tab, start an agent CLI in it, and submit the brief. Atomic.
bun $SKILL_DIR/scripts/spawn.ts --workspace <id> --label <text> --cwd <path> \
  --peer-name <name> --brief <file> [--kind claude|pi] [--agent <name>] \
  [--model <model>] [--effort <level>] [--permission-mode <mode>] \
  [--start-timeout <ms>] [--prompt-timeout <ms>]

# Durable run state at .herd/<batch>/roster.json.
bun $SKILL_DIR/scripts/roster.ts init --repo-root <dir> --batch <name> \
  --tickets <file> --coordinator-peer <name> --workspace <id> \
  --target <branch> [--concurrency <n>]
bun $SKILL_DIR/scripts/roster.ts set --repo-root <dir> --batch <name> \
  --id <ticket> --patch '<json>'
bun $SKILL_DIR/scripts/roster.ts summary --repo-root <dir> --batch <name> [--json]
```

`roster.ts init` rejects duplicate ids, unknown dependencies, self-dependencies,
and cycles — the graph problems that otherwise surface as a deadlocked batch.
`set` re-propagates blocks after every transition, so a failed ticket marks its
dependents immediately.
