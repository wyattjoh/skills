---
name: coordinate-implementation
description: Orchestrates a multi-ticket implementation run. Points at a `.scratch/<slug>/` folder holding a spec and numbered issues, then runs one Claude Code Opus high-effort implementor session per ticket inside herdr, reviews each result on two axes, loops fixes back, and fast-forwards main. Also resumes a run from its RESUME.md after a session handoff. Triggers on "/coordinate-implementation", "implement the tickets in", "orchestrate the run", "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>] [--base <branch>] [--implementor '<model> <effort>']"
disable-model-invocation: true
effort: low
---

# Coordinate an implementation run

You are the **orchestrator**. You never implement a ticket yourself. You run
one implementor session per ticket, using `claude` for Anthropic models and `pi` for non-Anthropic models, review its single commit, send fixes back
into the same session, and land it on `main`. Requires herdr (`HERDR_ENV=1`);
load the `herdr` skill in the same message: `/coordinate-implementation /herdr <args>`.

Arguments: `$ARGUMENTS`

- A run folder (`.scratch/<slug>`) starts or continues a run.
- `resume .scratch/<slug>` is the form a successor session receives after a
  handoff; do the **Resume** steps first.
- `--base <branch>` names the integration branch workers branch from and the
  coordinator fast-forwards. Default `main`. Recorded as `Base:` in RESUME.md
  on first run; later invocations read it from there.
- `--implementor '<model> <effort>'` overrides the default
  `claude --model claude-opus-5 --effort high` launch (see
  [session-launch.md](references/session-launch.md)).

If the invocation does not explicitly provide the run folder, base branch, or
implementor model/effort, ask a structured clarification question before
creating state or launching workers. Offer the documented defaults (`.scratch/<slug>`
from the prompt, `main`, and the configured default implementor) as the first,
recommended choices, but do not silently infer a missing option when multiple
projects, branches, or model families could apply. If the user explicitly
names a run folder and says to use defaults, proceed without asking again.

Everywhere below, `<base>` means that branch. The main checkout is never
`<base>` unless `<base>` is `main`.

## Run folder contract

```
.scratch/<slug>/
  spec.md            # the agreed design; review axis 2 reads it
  issues/NN-*.md     # one ticket per file, `Blocked by:` + `Status:` lines, checkboxes
  briefs/common.md   # shared implementor brief; create from references/common-brief.md if absent
  briefs/fixes-NN.md # long fix requests, one per round
  RESUME.md          # the ONLY state file: `Prefix:`, `Base:`, `Implementor:` lines, decisions, per-ticket table
  xdg-sandbox/       # XDG_DATA_HOME / XDG_CONFIG_HOME for implementor sessions
.scratch/coordinators.md   # repo-wide registry of active runs (below)
```

Ticket order is dependency order from the `Blocked by:` lines. Run **one
ticket at a time** unless RESUME.md records that the user allowed parallel
tickets.

## Several coordinators on one repo

Each run has a unique `Prefix:` (for example `dcs`) that names its branches
`wyattjoh/<prefix>-NN-<slug>`, its worker sessions `<prefix>-NN`, its herdr
tabs `claude <prefix> NN <slug>`, and its coordinator pane label
`coordinator <prefix>`.
The coordinator's own herdr tab is always labelled `coordinator`: on start
and on resume, find your tab (`herdr pane list` gives your pane's `tab_id`)
and run `herdr tab rename <tab> "coordinator"` before anything else.

`.scratch/coordinators.md` is the registry, one line per active run:

```
| prefix | base | run folder | workspace | coordinator pane | active tickets | updated |
```

- On start or resume: read it; refuse to start if the prefix is already
  listed with a live pane (`herdr pane list`), otherwise add or update your
  line. Warn the user when two runs on the same base touch the same ticket
  files or the same crates, then continue.
- Update your line whenever a ticket starts or lands and at handoff.
- Remove your line when the run finishes.

Runs that share a `<base>` land through one dedicated base worktree at
`.claude/worktrees/wyattjoh/<base>` and serialize by rebase-and-retry, no
lock: [review-and-land.md](references/review-and-land.md). Runs on different
repos need nothing beyond their own herdr workspace.

## Core loop (standing instructions)

Before the first iteration, rename your own tab to `coordinator` and label
your pane `coordinator <prefix>` (see above). Then repeat until every ticket
is landed:

1. **Start** the next unblocked ticket. Prefix the worker prompt with `/implement` for Claude or `/skill:implement` for Pi so the user-only implementation skill is loaded. Then create the worktree
   `.claude/worktrees/wyattjoh/<prefix>-NN-<slug>` on branch
   `wyattjoh/<prefix>-NN-<slug>` from `<base>`, a herdr tab, a worker session (`claude` for Anthropic models, `pi` for non-Anthropic models) for `<prefix>-NN`, then arm a background monitor. Exact commands:
   [session-launch.md](references/session-launch.md).
2. **Wait.** A 10-minute progress loop (below) plus the monitor are the only
   wake signals. Do not poll faster. While waiting, keep your own context low:
   read pane tails with `--lines 40`, never whole transcripts.
3. **Review** when the monitor settles or a commit appears: exactly one commit
   on the branch, gates green, two review agents (Standards, Spec) plus your
   own read. Procedure: [review-and-land.md](references/review-and-land.md).
4. **Fix loop.** One consolidated request per round into the same worker session;
   it amends its single commit and prints `FIXES DONE NN`. Re-arm the monitor.
   Verify mechanically (grep) and with a verification agent.
5. **Land.** Rebase the branch on `<base>` yourself, resolve conflicts yourself
   (`resolving-merge-conflicts` skill), rerun gates, `git merge --ff-only`
   in the base checkout, remove the worktree, close the tab. If the
   fast-forward is refused because `<base>` moved, rebase again and retry.
   Never delete the branch (the command guard blocks it; the user does it).
6. **Record** the outcome in RESUME.md's table and the registry line before
   starting the next ticket.

Session markers the implementor prints: `TICKET DONE NN`,
`TICKET BLOCKED NN: <question>`, `FIXES DONE NN`. Monitor on **agent status**,
not marker text; implementors forget to print it.

## Progress loop

Immediately after starting or resuming, schedule this with `/loop 10m`
(plain text, never a skill invocation: a scheduled fire cannot run a
`disable-model-invocation` skill):

> Progress check for the <slug> implementation run. For every active worker session
> (see `herdr pane list` agent_status and the RESUME.md table at
> .scratch/<slug>/RESUME.md): if agent_status is idle or done, or the branch has
> a new commit, the ticket is at a safe point — proceed with the agreed
> review / fix-loop / landing workflow and start the next ticket in dependency
> order. Also verify each background monitor (Bash wait / herdr agent wait) is
> still running and matches the current pane id; if one has fired spuriously or
> hung, replace it with
> `herdr agent wait <pane> --until idle --until done --until blocked`.
> If a session is stuck or crashed, apply the fallback rule.
> Also read your own context usage from `herdr pane read <own pane> --lines 6`
> (the `🧠` statusline figure). Only if the coordinator is running in Claude
> and exceeds 200,000 tokens, follow the handoff procedure at the next safe
> point. A coordinator running in Pi stays in the current session and never
> launches a successor for context usage. Report briefly.

Each tick: pane list, own context figure, per-ticket `git status --short` and
`git log --oneline <base>..HEAD` in the worktree, last 40 pane lines. Report in
three lines or fewer when nothing changed.

## Stall check

Alongside the progress loop, schedule a second `CronCreate` on
`5-59/10 * * * *` (offset five minutes from the progress loop) with the
stall-check prompt in [stall-check.md](references/stall-check.md). It catches
a worker whose `agent_status` stays `working` while nothing moves: an API
network error, a permission prompt, or a question waiting on input. Both crons
are session-only, so every start, resume, and handoff re-creates both.

## Worker fallback

Only when a worker session actually fails (crash, unrecoverable context loss,
repeated review failures) restart that ticket as a fresh
a same-family worker session: `claude --model claude-opus-5 --effort high --permission-mode auto` for Anthropic models, or `pi --model <model> --thinking <effort>` for non-Anthropic models, in
the same worktree, with the partial work described in its `IMPORTANT CONTEXT`
clause. A network outage or a compaction is not a failure: resume the same
session with a prompt first (or `claude --resume` in its worktree). Re-prompt
only if a compaction is followed by no edits for two ticks.

## Handoff at 200,000 tokens (Claude coordinators only)

Determine this from the **coordinator's runtime**, not the implementor's model.
Coordinators running in **Pi do not hand off**: continue in the current session,
keep RESUME.md current, and let Pi manage context compaction. Do not launch a
successor or stop loops and monitors because of context usage.

For coordinators running in **Claude**, when your own context passes
**200,000 tokens**, hand off at the **next safe point** (finish the in-flight
review / fix / land step; do not start the next ticket). Procedure and
successor launch command: [handoff.md](references/handoff.md).

## Resume

When invoked as `resume .scratch/<slug>` or from a handoff:

1. Read `RESUME.md` in the run folder; it names the prefix, base, active
   ticket, worktree, pane id, and what remains.
2. `herdr pane list`; pane ids compact, so trust the list over RESUME.md.
   Rename your own tab to `coordinator` (`herdr tab rename`) and label your
   own pane `coordinator <prefix>` (`herdr pane rename`).
3. Update your line in `.scratch/coordinators.md`.
4. For each active ticket: `git status --short` and `git log <base>..HEAD` in
   its worktree; re-arm the monitor on its pane.
5. Schedule the progress loop, then run one tick immediately.
6. Report the state in a short list and end the turn.

## Rules that are not negotiable

- One commit per ticket branch; fixes amend it.
- Every commit passes CI's exact invocations before review
  ([review-and-land.md](references/review-and-land.md) lists them).
- Never push, never touch remotes, never write to GitHub issues.
- Never run the built binaries or `atk`; implementor sessions get the XDG
  sandbox so an accident cannot touch `~/.local/share/agent-toolkit`.
- Rebase conflicts are yours, never the implementor's.
- Report outcomes faithfully: a red gate is reported as red with its output.
