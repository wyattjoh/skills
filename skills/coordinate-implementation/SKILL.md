---
name: coordinate-implementation
description: Orchestrates a multi-ticket implementation run. Points at a `.scratch/<slug>/` folder holding a spec and numbered issues, then runs dependency-ready tickets in parallel by default, reviews each result on two axes, loops fixes back, and fast-forwards the integration branch. Repository-specific commands and safety constraints are discovered from project instructions and CI rather than assumed. Scheduling mode, model, harness, effort, and worker skills are recorded in RESUME.md so they survive handoffs and mid-run changes. Triggers on "/coordinate-implementation", "implement the tickets in", "orchestrate the run", "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>] [--base <branch>] [--implementor '<model> <effort>'] [--serial | --parallel]"
disable-model-invocation: true
effort: low
---

# Coordinate an implementation run

You are the **orchestrator**. You never implement a ticket yourself. You run
one implementor session per ticket, start every dependency-ready ticket in
parallel by default, review each single commit, send fixes back into the same
session, and land it on the configured integration branch. Requires herdr
(`HERDR_ENV=1`);
load the `herdr` skill in the same message: `/coordinate-implementation /herdr <args>`.

Arguments: `$ARGUMENTS`

- A run folder (`.scratch/<slug>`) starts or continues a run.
- `resume .scratch/<slug>` is the form a successor session receives after a
  handoff; do the **Resume** steps first.
- `--base <branch>` names the integration branch workers branch from and the
  coordinator fast-forwards. Default `main`. Recorded as `Base:` in RESUME.md
  on first run; later invocations read it from there.
- `Branch template:` in RESUME.md records the repository's branch naming rule.
  Resolve it from repository instructions on first run, or use
  `<prefix>-NN-<slug>` when the repository has no rule.
- `--implementor '<model> <effort>'` sets the implementor model and effort.
  The harness is resolved from the model and persisted; everything else about
  the record (worker skills, coordinator settings) is changed in prose.
- `--serial` runs at most one active ticket. `--parallel` explicitly restores
  the default parallel scheduler. Reject an invocation that passes both.
  Record the selected value as `Mode:` in RESUME.md. On a first run with neither
  flag, use `parallel`; on a resume with neither flag, preserve the recorded
  mode. An explicit flag on resume is a preference change: write and log it
  before scheduling more work.

If the invocation does not explicitly provide the run folder, base branch,
implementor model/effort, or your own coordinator effort, ask a structured
clarification question before creating state or launching workers. Offer the
documented defaults (`.scratch/<slug>` from the prompt, `main`, the configured
default implementor, coordinator effort `low`) as the first, recommended
choices, but do not silently infer a missing option when multiple projects,
branches, or model families could apply. If the user explicitly names a run
folder and says to use defaults, proceed without asking again.

Your own harness and model are introspected; your effort is the one value you
cannot see, which is why it joins that question. Successors inherit the whole
`Coordinator:` record and are never asked again.

Everywhere below, `<base>` means that branch. The main checkout is never
`<base>` unless `<base>` is `main`.

## Run folder contract

```
.scratch/<slug>/
  spec.md            # the agreed design; review axis 2 reads it
  issues/NN-*.md     # one ticket per file, `Blocked by:` + `Status:` lines, checkboxes
  briefs/common.md   # resolved repository contract; create from references/common-brief.md if absent
  briefs/fixes-NN.md # long fix requests, one per round
  RESUME.md          # the ONLY mutable state file; format: references/resume-format.md
.scratch/coordinators.md   # repo-wide registry of active runs (below)
```

Ticket order is dependency order from the `Blocked by:` lines. A ticket is
unblocked only when every listed blocker has status `landed`. `Mode: parallel`
is the default and starts every currently unblocked queued ticket; `Mode:
serial` starts only the first unblocked queued ticket and never has more than
one active ticket. Do not serialize parallel mode merely because two tickets
might touch nearby code. Their branches synchronize against the latest
`<base>` before review and landing.

## Preferences

Which model, which harness, which effort, and which skills each side runs are
**recorded state**, not conversational memory. The canonical format, the
harness vocabulary table, and the validation rules are in
[resume-format.md](references/resume-format.md). The rules for keeping the
record true:

- **The write is the acknowledgement.** A preference the user states and you
  have not yet written to RESUME.md does not exist. Write the file _before_
  you reply, then reply. This is not negotiable: the alternative is a
  preference that survives only as long as your context does.
- **Resolve once, persist the resolution.** You have the conversation; a
  successor does not. Derive the harness from the model at record time and
  write `harness`, `model`, `effort`, and `skills` explicitly. Never make a
  later reader re-derive a field you could have recorded.
- **On resume, an explicit flag wins and is written back.** `--implementor`,
  `--serial`, or `--parallel` passed at a resume is a preference change: apply
  it, write it, and log it. `--base` is the exception and the file wins;
  resume-format.md says why.
- **A ticket binds its record at start.** The run-wide `Implementor:` governs
  the next ticket to _start_. A ticket already running keeps the record in its
  table row for its whole life, through fix rounds and crash-restarts.
- **Log every change.** Append a dated line to `## Decisions` with the reason.
- **Re-read RESUME.md at each progress tick**, so a hand edit is honored and
  you never overwrite one blindly.
- **Never bake a preference value into a scheduled prompt.** See
  [Progress loop](#progress-loop).

## Several coordinators on one repo

Each run has a unique `Prefix:` (for example `dcs`) that names its worker
sessions `<prefix>-NN`, its herdr tabs `claude <prefix> NN <slug>`, and its
coordinator pane label `coordinator <prefix>`. Pi renders the run's
`Branch template:` from RESUME.md. Claude Code lets `EnterWorktree` generate
its native worktree name and `worktree-*` branch. Always use the actual
worktree path and branch returned by the coordinator harness.
The coordinator's own herdr tab is always labelled `coordinator`: on start and
on resume, run `herdr tab rename "$HERDR_TAB_ID" "coordinator"` before anything
else. Identify yourself from the `HERDR_PANE_ID` / `HERDR_TAB_ID` /
`HERDR_WORKSPACE_ID` environment variables injected into every managed pane,
never by inspecting `herdr pane list` for the focused pane: focus can belong to
the user or another client and can move at any time.

`.scratch/coordinators.md` is the registry, one line per active run:

```
| prefix | base | run folder | workspace | coordinator pane | active tickets | updated |
```

- On start or resume: read it; refuse to start if the prefix is already
  listed with a live pane (`herdr pane list`), otherwise add or update your
  line. Warn the user when two runs on the same base touch the same ticket
  files or implementation areas, then continue.
- Update your line whenever a ticket starts or lands and at handoff.
- Remove your line when the run finishes.

Runs that share a `<base>` land through one dedicated base checkout and
serialize by rebase-and-retry, no lock. The main checkout holds `main`;
non-main base checkouts follow the coordinator harness's native worktree
lifecycle: [session-launch.md](references/session-launch.md) and
[review-and-land.md](references/review-and-land.md). Runs on different repos
need nothing beyond their own herdr workspace.

## Core loop (standing instructions)

Before the first iteration, resolve `<run>/briefs/common.md` from
[common-brief.md](references/common-brief.md), repository instructions, and CI.
No placeholder may remain when a worker launches. Rename your own tab to
`coordinator` and label your pane `coordinator <prefix>` (see above). Then
repeat until every ticket is landed:

1. **Schedule.** Read `Mode:` and the dependency graph from RESUME.md and the
   ticket files. Verify `Base sha:` against the base checkout and update it if
   the branch moved. In `parallel` mode, start every unblocked queued ticket. In
   `serial` mode, start only the first unblocked queued ticket and only when no
   ticket is active. Bind the current `Implementor:` record into each selected
   ticket's table row before starting it; that row, not the run-wide record,
   governs the ticket from then on. Its `skills` list must begin with
   `implement`. Do not require `implement` to appear in skill discovery; it is
   user-invoked and explicitly prefixed. Render the ordered list into the
   worker prompt prefix for its harness. Create each ticket worktree from the
   current `<base>` using the **coordinator's** harness: Claude Code uses
   `EnterWorktree`; Pi uses Pando. Record its runtime block, create a herdr tab
   and worker session, then arm a background monitor. Exact procedure:
   [session-launch.md](references/session-launch.md).
2. **Wait.** A 10-minute progress loop (below) plus the monitors are the only
   wake signals. Do not poll faster. While waiting, keep your own context low:
   read pane tails with `--lines 40`, never whole transcripts.
3. **Review** when a monitor settles or a commit appears. If several tickets
   become ready together, process them one at a time in dependency order. Sync
   the chosen branch to the latest `<base>` before its final gates and review,
   then require exactly one commit, green gates, two review agents (Standards,
   Spec), and your own read. Procedure:
   [review-and-land.md](references/review-and-land.md).
4. **Fix loop.** One consolidated request per round into the same worker session;
   it amends its single commit and prints `FIXES DONE NN`. Re-arm that ticket's
   monitor. Verify mechanically (grep) and with a verification agent.
5. **Land.** Serialize all landings through the recorded base checkout with
   `git merge --ff-only`. If `<base>` moved after review, sync again, resolve
   textual conflicts yourself (`resolving-merge-conflicts` skill), rerun gates
   and targeted review, then retry. Substantive adaptations found after a
   conflict go back to the same implementor as a fix round. After landing,
   close the tab and finish through the coordinator's harness: Claude Code uses
   `ExitWorktree`; Pi uses `pando remove`. Claude Code may delete its native
   `worktree-*` branch during cleanup. Pando retains the branch it created;
   never delete that retained branch separately.
6. **Record and refill.** Update the ticket table, remove its active runtime
   block, update `Base sha:` and the registry line, then immediately schedule
   every ticket newly unblocked by the landing according to `Mode:`.

Session markers the implementor prints: `TICKET DONE NN`,
`TICKET BLOCKED NN: <question>`, `FIXES DONE NN`. Monitor on **agent status**,
not marker text; implementors forget to print it.

## Progress loop

Immediately after starting or resuming, schedule this with `/loop 10m`
(plain text, never a skill invocation: a scheduled fire cannot run a
`disable-model-invocation` skill).

**A scheduled prompt carries the run folder path and nothing else.** Never
write a preference value into it: a cron is scheduled once and fires for
hours, so an inlined threshold or model keeps firing after the record has
changed. Every value the prompt needs is read from RESUME.md at fire time,
which makes the crons stateless and a preference change self-propagating.

> Progress check for the <slug> implementation run. For every active worker session
> (see `herdr pane list` agent_status and the RESUME.md table at
> .scratch/<slug>/RESUME.md): if agent_status is idle or done, or the branch has
> a new commit, the ticket is at a safe point: proceed with the agreed
> review / fix-loop / landing workflow. Process multiple ready tickets one at a
> time in dependency order, then schedule newly unblocked tickets according to
> `Mode:`. Also verify each background monitor (Bash wait / herdr agent wait) is
> still running and matches the current pane id; if one has fired spuriously or
> hung, replace it with
> `herdr agent wait <pane> --until idle --until done --until blocked`.
> If a session is stuck or crashed, apply the crash-restart rule.
> Also read your own context usage from
> `herdr pane read "$HERDR_PANE_ID" --lines 6` (the `🧠` statusline figure).
> Read `Coordinator.handoff` and `Coordinator.threshold` from RESUME.md and
> compare your context against them: only if `handoff` is `yes` and your
> context exceeds `threshold`, follow the handoff procedure at the next safe
> point. Report briefly.

Each tick: re-read RESUME.md, compare and update `Base sha:`, read the pane
list and own context figure, then inspect per-ticket `git status --short`,
`git log --oneline <base>..HEAD`, and the last 40 pane lines. Update every
active runtime block's pane, phase, and monitor state before acting. Run the
scheduler even when no worker changed, so a hand-edited mode or newly unblocked
queued ticket takes effect. Report in three lines or fewer when nothing
changed.

## Stall check

Alongside the progress loop, schedule a second `CronCreate` on
`5-59/10 * * * *` (offset five minutes from the progress loop) with the
stall-check prompt in [stall-check.md](references/stall-check.md). It catches
a worker whose `agent_status` stays `working` while nothing moves: an API
network error, a permission prompt, or a question waiting on input. Both crons
are session-only, so every start, resume, and handoff re-creates both.

## Crash-restart

Only when a worker session actually fails (crash, unrecoverable context loss)
restart that ticket in the same worktree, **with the record bound in its table
row**: same harness, same model, same effort, same skills, with the partial
work described in its `IMPORTANT CONTEXT` clause. Never escalate here and never
read the run-wide `Implementor:`. A crash is evidence about a process, not
about a model, and silently substituting a different one is how an override
gets lost to a network blip.

A network outage or a compaction is not a failure: resume the same session with
a prompt first (or `claude --resume` in its worktree). Re-prompt only if a
compaction is followed by no edits for two ticks.

## Escalation

Distinct from crash-restart, and never call either one "the fallback rule".
Trigger: a ticket is still failing review after a **third** fix round. That is
evidence the bound model is not converging on this ticket.

- Escalation is **per ticket**. Record it in the ticket's `esc` column and in
  `## Decisions`. Never rewrite the run-wide `Implementor:`: one ticket's
  difficulty is not a judgement about the remaining tickets.
- `Coordinator.unattended` decides whether you may act alone. Default `block`:
  set the ticket's status to `blocked`, log what you would escalate to and why,
  run the scheduler for other unblocked tickets according to `Mode:`, and
  surface the block at the next progress tick. The run keeps moving and no
  model changes without the user. `escalate`
  pre-authorizes it for overnight runs.
- `unattended` governs this decision only. A `TICKET BLOCKED` question, a scope
  decision, and an invalid-record prompt always wait for the user.

## Handoff

Driven by `Coordinator.handoff` and `Coordinator.threshold` in RESUME.md, never
by a number written here. `handoff` defaults from the coordinator's own harness
(`claude` -> `yes`, `pi` -> `no`), because Pi manages its own context
compaction and has nothing to hand off to.

When `handoff` is `yes` and your own context passes `threshold`, hand off at the
**next safe point** (finish the coordinator-owned review / fix / land action;
do not start more tickets, but do not wait for every active worker to finish).
When it is `no`, stay in the current session, keep RESUME.md
current, and never launch a successor or stop loops and monitors for context
usage. Procedure and successor launch: [handoff.md](references/handoff.md).

## Resume

When invoked as `resume .scratch/<slug>` or from a handoff:

1. Read `RESUME.md` in the run folder and validate it against
   [resume-format.md](references/resume-format.md). It names the prefix, base,
   base sha, scheduling mode, branch template, both records, every active
   ticket's worktree and pane, and what remains. A file that does not match the
   template stops the resume with an explanation; there is no migration path
   and nothing is guessed.
   If this invocation also passed `--implementor`, `--serial`, or `--parallel`
   and it differs from the record, that is a preference change: validate it,
   write it, log it in `## Decisions`, and apply it when scheduling more work.
2. `herdr pane list`; pane ids compact, so trust the list over RESUME.md.
   Rename your own tab to `coordinator` and label your own pane
   `coordinator <prefix>`, using `$HERDR_TAB_ID` and `$HERDR_PANE_ID`.
3. Compare `Base sha:` with the base checkout. If it moved, inspect every
   active branch against the new base, then record the observed sha.
4. Update your line in `.scratch/coordinators.md`.
5. For each active ticket: validate its runtime block, run `git status --short`
   and `git log <base>..HEAD` in its worktree, refresh its pane and phase, and
   re-arm the monitor on its pane with `Monitor: armed`.
6. Schedule the progress loop, then run one tick immediately.
7. Report the state in a short list and end the turn.

## Rules that are not negotiable

- A preference the user states and you have not written to RESUME.md does not
  exist. Write before you reply.
- Never substitute a default model, effort, or skills list to keep a run
  moving. A record that will not launch stops the ticket and is reported.
- One commit per ticket branch; fixes amend it.
- Every commit passes the repository's required gates before review. The
  resolved commands live in `<run>/briefs/common.md`; the execution procedure
  is in [review-and-land.md](references/review-and-land.md).
- Never push, perform remote writes, or write to forge issues.
- Enforce every project-specific safety constraint recorded in the shared
  brief. Do not invent restrictions that the repository does not require.
- Textual rebase conflicts are yours, never the implementor's. If the rebased
  result needs a substantive behavioral adaptation, send that work back to the
  same implementor as a fix round and review it again.
- Report outcomes faithfully: a red gate is reported as red with its output.
