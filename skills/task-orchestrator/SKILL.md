---
name: task-orchestrator
description: >-
  Orchestrates a batch of work units across isolated agents in their own git
  worktrees, with a per-task review loop and serialized merges into an
  integration branch. Use when given a directory of plan files, a list of
  tasks, or several independent changes to run in parallel. Triggers on
  "parallelize this work", "run these plans in parallel", "spin up an agent per
  task", "orchestrate these tasks", "fan out these plans", "work through this
  plan directory", or "coordinate agents for each unit of work".
argument-hint: "[plans-dir | task-list] [--target <branch>] [--concurrency N]"
effort: high
---

# Task Orchestrator

Coordinate a batch of work units in parallel. You stay in the main session as
the **coordinator**: you fan out one isolated implementer agent per unit, drive
an independent review→fix loop on each, and serially integrate the approved
results into one branch. Implementers and reviewers do the work; you own the
schedule, the merges, and the conversation with the user.

The split that keeps this reliable: **graph correctness is deterministic**
(handled by the tested `plan-graph.ts` helper), while **dispatch, the review
loop, conflict resolution, and merge decisions are judgment** you run from this
procedure. Never hand-compute the dependency graph.

## Quick Start

1. **Parse.** Run the helper to turn the input into a validated manifest:
   ```bash
   bun $SKILL_DIR/scripts/plan-graph.ts <plans-dir-or-files...> --pretty
   ```
   For an inline task list, write the tasks to a JSON file
   (`[{ "id": "...", "dependsOn": [...] }]`) and pass `--from-json <file>`.
   Exit code `1` means the manifest has errors (cycle / unknown dep / duplicate
   id) — stop and surface them.
2. **Confirm (the safety gate).** Show the user the task list, the dependency
   DAG, the resolved **merge target**, and the concurrency cap. Do nothing
   destructive until they approve. See [Confirmation gate](#confirmation-gate).
3. **Set up.** Create the integration branch, **locally exclude the journal path
   from git** (below), write the initial **state journal** (below), verify it
   with `state.ts summary`, create a Task-tool entry per task, and register the
   journal with the dashboard daemon. See [Dashboard](#dashboard).
4. **Run the ready-queue loop** until every task is merged, escalated, or
   blocked, rewriting the journal at every transition. See
   [The orchestration loop](#the-orchestration-loop).
5. **Report.** Unregister the journal from the dashboard daemon, summarize
   merged / escalated / blocked tasks, list any retained worktree paths, and
   offer to open a PR for the integration branch.

If you are **resuming** (a journal already exists for this batch, or your own
context was compacted), do not start fresh — see
[Resumption](#resumption-after-compaction-or-restart).

## Inputs

Accept any of: a directory (one task per `*.md` plan file), an explicit list of
plan files or globs, a single multi-section plan, or an inline task list in the
prompt.

- **Directory / file list** → pass paths straight to `plan-graph.ts`.
- **Inline list** → assign each item an id, translate any "after #N" notation
  into `dependsOn`, write a JSON array, and pass `--from-json`.
- **Single multi-section file** → do **not** guess the split. Surface the
  sections and ask whether it is one task or N before proceeding.

Dependencies are **explicit only**. Plan files declare them in frontmatter
(`depends-on: [other-id]`); inline items use `after #N`. Never infer an edge
silently — if you strongly suspect a missing one, propose it in the
confirmation gate for the user to accept.

## Operator defaults

Personalizable defaults (the integration-branch namespace and the fallback
concurrency) live in `~/.config/task-orchestrator/defaults.json`, not in this
skill. Resolve them once, while preparing the confirmation gate:

```bash
bun $SKILL_DIR/scripts/defaults.ts read
```

- If the output is `{"configured":true,...}`, use its `branchPrefix` and
  `concurrency`.
- If it is `{"configured":false,...}`, the operator has not set defaults yet.
  **Prompt the user** (AskUserQuestion) for the integration-branch namespace
  (e.g. their GitHub username or team, used as `<branchPrefix>/<batch>`), then
  persist it so the prompt never recurs:

  ```bash
  bun $SKILL_DIR/scripts/defaults.ts write --branch-prefix <prefix> [--concurrency <n>]
  ```

  Re-read (or use the printed result) and continue. Only `branchPrefix` is
  required; `concurrency` is optional and defaults to 3.

`--target <branch>` at invocation still overrides the resolved default entirely,
in which case you can skip the prompt.

## Confirmation gate

Resolve and present before any worktree, branch, or merge action:

- **Task list** with ids and titles.
- **DAG** — render edges (e.g. `00-schema → 01-api → 02-ui`) and the initial
  ready set. If `plan-graph.ts` returned errors, this is where they stop the run.
- **Merge target** — resolved at invocation. Default: a new integration branch
  `<branchPrefix>/<batch>` off the current base, where `branchPrefix` comes from
  the operator's defaults (see [Operator defaults](#operator-defaults)).
  `--target <branch>` overrides; an explicit choice to merge into the
  current/given branch is the only way work lands outside a fresh integration
  branch.
- **Concurrency cap** — simultaneous task pipelines. `--concurrency` overrides;
  otherwise use the `concurrency` from the operator defaults (which itself
  defaults to 3).

Wait for explicit approval. After approval, run autonomously to completion,
surfacing only escalations and the final report.

## Dashboard

After the confirmation gate and state-journal setup, but before the first task
starts, always register the journal with the dashboard daemon. The dashboard is
a reader only; it must not be the first component to create the batch directory.
Register only after `state.ts summary <batch>` succeeds for the same root.

```bash
bun $SKILL_DIR/scripts/dashboard.ts register .claude/task-orchestrator/<batch>/state.json --pid "$PPID"
```

This is a fast foreground command. It ensures the daemon is running and
registers the state journal for the current coordinator process lease.

Report the dashboard URL, `http://127.0.0.1:3837/`, after registration. The
default browser is not opened automatically. Offer to open the URL for the user.
Use `--open` only after the user has explicitly agreed to open the browser.

The dashboard serves a small local web UI and an SSE endpoint. It watches the
state-journal directory and pushes each `state.json` rewrite to connected
browsers. The SSE endpoint also sends keep-alive comment frames every 5 seconds
so idle streams remain open between journal rewrites. The browser also exposes
`/state` for a point-in-time JSON snapshot. If `/state` reports that the journal
is not readable yet, unregister the journal, run the journal initialization
step, verify `state.ts summary`, and register the journal again. Do not continue
execution with a dashboard pointed at a missing journal.

## The orchestration loop

Maintain a **ready set**: a task is eligible once all its dependencies have
merged. Keep the ready set running up to the concurrency cap; re-evaluate
readiness after every merge. Per task, run this pipeline:

1. **Worktree.** Create a persistent worktree at
   `.claude/worktrees/<batch>/<task-id>` branched off **current integration
   HEAD** (so it already contains merged dependencies). The same worktree is
   shared by every agent and round for this task — do not use the Agent tool's
   ephemeral per-call isolation.
2. **Implement.** Dispatch a `claude` implementer with the plan content and the
   worktree path as its working directory. Definition of done: commit the work
   in the worktree, self-verify, and return `{ status: "done" | "blocked",
summary }`. Keep this agent alive — later rounds and the rebase reuse it via
   `SendMessage`.
3. **Review.** Dispatch the `pr-review-toolkit:code-reviewer` agent on the
   worktree diff, judged against the task's plan (use an explicit "acceptance
   criteria" / "done when" section if present, else the plan body) plus project
   conventions. Expect a verdict: `{ verdict: "approved" |
"changes_requested", comments }`. Keep this reviewer alive too.
4. **Fix loop.** On `changes_requested`, `SendMessage` the comments to the same
   implementer; re-review with the same reviewer (so it confirms its prior
   comments were addressed). Cap at **3 rounds**. Hitting the cap without
   approval → **escalate** (below).
5. **Rebase + re-verify.** On `approved`, have the implementer rebase its branch
   onto current integration HEAD in its worktree. Clean rebase → continue. On
   conflict, the **implementer** resolves it (it has the context), then the
   reviewer re-approves the resolved diff. Then run the **verification gate**:
   the detected project check (e.g. `bun run check && bun test`) in the
   worktree. A failure here counts against the same 3-round cap and bounces back
   to the implementer like a conflict. No detectable command → skip with a note.
6. **Merge.** On a clean, verified, approved branch, fast-forward merge it into
   the integration branch yourself (merges are serialized, so no lock is
   needed). Prune the worktree, delete the task branch, mark the task merged,
   and re-evaluate the ready set.

At each transition, update **both** the task's Task-tool entry (the live UI) and
the **state journal** (the durable record): set `status`, `round`, the
`worktree`/`branch` paths, the `implementerAgent`/`reviewerAgent` handles the
moment those agents are spawned, the `lastVerdict`, `outstandingComments`, and
`mergedSha` on merge. The agent handles are the part you cannot reconstruct
after a compaction, so record them immediately.

See [references/orchestration-loop.md](references/orchestration-loop.md) for the
full state machine, escalation handling, and merge edge cases.

## State journal

A single JSON checkpoint makes the flow survive coordinator compaction and
session restarts. It lives at `.claude/task-orchestrator/<batch>/state.json` —
deliberately **outside** any worktree.

**Never commit the journal.** It is throwaway runtime state, not project content.
Two safeguards, both required:

1. At setup, add the journal root to the repo's **local** exclude (per-clone,
   never committed, applies in the main worktree and all linked worktrees):
   ```bash
   exclude="$(git rev-parse --git-common-dir)/info/exclude"
   for p in '.claude/task-orchestrator/' '.claude/worktrees/'; do
     grep -qxF "$p" "$exclude" 2>/dev/null || echo "$p" >> "$exclude"
   done
   ```
   (The journal lives outside any worktree and the linked worktrees sit under
   `.claude/worktrees/`; excluding both keeps the integration tree from ever
   showing them as untracked or staging them.)
2. Never `git add` the journal path, and never `git add -A`/`git add .` in a tree
   where it could be staged. Stage only the task's actual code changes.

Do **not** add it to the tracked `.gitignore` — the exclude is local on purpose,
so the skill never mutates a checked-in file as a side effect of running.

Initialize it once, immediately after the confirmation gate and before
registering the dashboard, from the manifest:

```bash
mkdir -p .claude/task-orchestrator/<batch>
bun $SKILL_DIR/scripts/plan-graph.ts <plans-dir-or-files...> --pretty > .claude/task-orchestrator/<batch>/manifest.json
bun $SKILL_DIR/scripts/state.ts init <batch> \
  --manifest .claude/task-orchestrator/<batch>/manifest.json \
  --base-branch <base> \
  --integration-branch <integration-branch> \
  --concurrency <n>
bun $SKILL_DIR/scripts/state.ts summary <batch>
```

`state.ts init` refuses to overwrite an existing journal unless `--force` is
passed. Do not use `--force` while resuming; read and reconcile the existing
journal instead.

The journal records, per task: `status`, `round`, `worktree`, `branch`,
`implementerAgent`, `reviewerAgent`, `lastVerdict`, `outstandingComments`,
`mergedSha`, `statusSince`. Rewrite it (atomically — the helper does temp-file +
rename) at every transition listed above. Treat **git as the source of truth for
"merged"** and the journal as the source of truth for in-flight detail (round,
comments, agent handles).

`statusSince` (the ISO time the current status was entered) powers the dashboard
time-in-state timer. It is stamped automatically by `updateTask` whenever the
status actually changes, so drive every status transition through `updateTask`
rather than hand-editing `status` in the JSON; a hand-edit leaves `statusSince`
stale and the timer wrong.

## Resumption (after compaction or restart)

When a journal already exists for the batch, reconcile before doing anything:

1. **Read** the journal (`state.ts summary <batch>`) and **reconcile against
   git**: any task whose branch is already merged into the integration branch is
   `merged`, regardless of what the journal last recorded.
2. **Re-derive the ready set** from the reconciled state.
3. **Register the dashboard.** Run this after the journal summary succeeds:
   ```bash
   bun $SKILL_DIR/scripts/dashboard.ts register <journal-path> --pid "$PPID"
   ```
   The command is idempotent. If the daemon crashed while the coordinator stayed
   alive, this is the manual fix that restarts the daemon if needed and
   re-registers the journal.
4. **Re-attach in-flight tasks** by tier:
   - **Soft (same session, agents still alive):** `SendMessage` the stored
     `implementerAgent` / `reviewerAgent` handles to continue exactly where they
     left off — full context intact, no rework.
   - **Hard (agents gone):** re-spawn a fresh implementer/reviewer for the task,
     seeded with the worktree diff and the journal's `outstandingComments`, so it
     resumes near its last round rather than from scratch. Continue counting
     against the same 3-round cap.
5. **Never double-dispatch.** A task already `merged` in git is done even if the
   journal looked mid-flight; a task with a live agent handle is resumed, not
   restarted.

## Escalation and failure

- **Review cap reached / verification keeps failing** → pause the task, surface
  its diff and outstanding comments to the user, and hold its dependents
  blocked. Retain the worktree.
- **Implementer returns `blocked` or an agent dies unrecoverably** → fail-soft.
  The task's dependents are blocked; unrelated tasks keep running.
- **Cycle / unknown dep / duplicate id** → caught at the gate by `plan-graph.ts`;
  never starts.

Always retain worktrees for unresolved tasks and report their paths so the user
can inspect or finish them by hand.

## Report

At the end of the run, unregister the journal from the dashboard daemon before
the final user report:

```bash
bun $SKILL_DIR/scripts/dashboard.ts unregister .claude/task-orchestrator/<batch>/state.json
```

This is the polite fast path that removes the completed batch from the shared
dashboard. If the daemon is already stopped, the command reports that unregister
was skipped and the final report can continue.

## Scripts

Validate input and build the manifest:

```bash
bun $SKILL_DIR/scripts/plan-graph.ts <paths...> [--from-json <file>] [--pretty]
```

Where `$SKILL_DIR` resolves to `~/.claude/skills/task-orchestrator/`. Outputs a
JSON manifest (`tasks`, `edges`, `readySet`, `errors`, `ok`) and exits non-zero
when the graph is invalid.

Resolve or persist the operator's defaults (integration-branch namespace and
fallback concurrency):

```bash
bun $SKILL_DIR/scripts/defaults.ts read [--config <path>]
bun $SKILL_DIR/scripts/defaults.ts write --branch-prefix <prefix> [--concurrency <n>] [--config <path>]
```

`read` prints `{"configured":false,...}` when the file is absent (not an error)
and `{"configured":true,...}` with the resolved values otherwise; a
present-but-corrupt file exits non-zero. `write` validates the branch prefix as
a git-ref-safe namespace and creates `~/.config/task-orchestrator/` as needed.
See [Operator defaults](#operator-defaults).

Inspect a state journal during a run or on resume:

```bash
bun $SKILL_DIR/scripts/state.ts summary <batch> [--root <dir>]
```

Prints the resume summary (merged / in-flight with agent handles / escalated /
blocked / ready). The journal-shaping helpers (`initState`, `updateTask`,
`computeReady`, `reconcileWithGit`, `propagateBlocks`, `writeState`) are exported
from `state.ts` for the coordinator's own bookkeeping.

Create the initial state journal after the user approves the batch:

```bash
bun $SKILL_DIR/scripts/state.ts init <batch> \
  --manifest <manifest.json> \
  --base-branch <base> \
  --integration-branch <integration-branch> \
  --concurrency <n> \
  [--root <dir>]
```

It writes `.claude/task-orchestrator/<batch>/state.json` atomically and prints
the path. It fails if the manifest is invalid or the state file already exists.

Manage the shared dashboard daemon:

```bash
bun $SKILL_DIR/scripts/dashboard.ts register <journal-path> --pid <pid> [--host 127.0.0.1] [--port 3837] [--open]
bun $SKILL_DIR/scripts/dashboard.ts unregister <journal-path> [--host 127.0.0.1] [--port 3837]
bun $SKILL_DIR/scripts/dashboard.ts serve [--host 127.0.0.1] [--port 3837] [--open]
bun $SKILL_DIR/scripts/dashboard.ts status [--host 127.0.0.1] [--port 3837]
```

- `register` ensures the daemon is running and registers a state journal for the
  foreground coordinator process identified by `--pid`.
- `unregister` removes a state journal from the daemon when the run finishes.
- `serve` is internal; `register` starts it when no healthy daemon is already
  available.
- `status` prints daemon health and the registered batches.

The daemon reads each registered state journal, renders task progress, and
streams updates to the browser with server-sent events whenever the journal is
rewritten.
