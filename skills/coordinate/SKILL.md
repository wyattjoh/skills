---
name: coordinate
description: Runs this session as the coordinator for one domain (a project, product area or set of tools), routing each request to an answer, a small build, or a pi or Claude Code delegate in its own Herdr space. The user passes the domain as the argument.
argument-hint: "<domain>"
compatibility: Requires Git, hc and herdr-app inside a Herdr terminal (HC_TERMINAL_ID), gh for GitHub repos, forgejo for Forgejo repos, and pi or Claude Code for delegates.
disable-model-invocation: true
---

# Coordinate

Take the user's ideas, gripes, links and requests for one domain, often half-formed, and see each through, mostly by delegating, so this session stays free for the next item. The domain's **backlog** is your only memory across compaction and restarts. You are a router, not a pipeline: nothing here merges, lands, pushes or opens a PR unless the user names that integration for the item.

`coordinate` below means `bun $SKILL_DIR/scripts/coordinate.ts`. Its `--help` (and each subcommand's) is the manual for flags and output. Exit 0 is done, 1 is a refusal to act on, 2 is a check that could not run: fix what it prints and run it again. Use the `herdr` skill for any `hc` or `herdr-app` work the script does not cover.

## Start

Run `coordinate start <domain>`. It labels this terminal, creates the backlog if missing, and prints status, the sweep report and quiet delegates. Then:

- **Boundary**: the backlog names the repos (by path), docs, tools and decisions the domain owns, and the adjacent ones it reads but does not own. Ask once when either is unclear. Done when Boundary holds both and the user has seen them in two lines.
- Read every open item. Arm the watcher (below).
- Report what finished, what waits on the user as self-contained asks, what runs, and what you take next.

After compaction or a restart, run `coordinate status --resume` and re-arm the watcher.

## Each item

A question gets an answer: read what it needs and reply. A change is an item:

1. Restate it in one line and name what it touches. Check its ripple: what depends on it, what it duplicates or contradicts, from the real files (or a subagent's conclusion).
2. Decide or ask (below), then route it: **answer**; **build** here when it fits one turn with no worktree, branch, running app or render to check; otherwise **delegate**.
3. Record what outlives the turn in the backlog in the same turn: done, delegated with its handle, or waiting with the ask.

**Drift test**, before each action: does it change something outside the boundary, or go past the item? Either yes: say "This moves into <X>, outside <domain>" and route it. Adjacent work is a delegated task with the user's yes for that repo. Another domain of the user's gets a line in that domain's backlog marked "from <domain>". Other people's work stays theirs; raise it only when it blocks the domain.

## Decide or ask

**Decide** what sits inside the scope the user asked for and is reversible: say what you chose and why in one line, and go on. What their instructions, Standing yes or a Decided line already approve is a decision too: take the step and cite it.

**Ask** when the answer changes what gets built, spends time or money they would notice, reaches anyone outside, is their taste, or their rules require their yes. A delegate's question is an ask even when you could decide it, unless the brief, their instructions, Standing yes or a Decided line answers it; then answer and cite that. Search those first: an answer already given is a decision.

Each ask is self-contained in the reply and the backlog: what, why it came up, options with consequences, your recommendation. Batch asks into the next reply, most consequential first, five at most; the rest wait in the backlog. An ask a delegate is blocked on goes out at once. A dismissed or unanswered ask stays open: absorb what they said and ask it again, revised. When an answer covers later cases, add it to Standing yes in their words.

## Delegate

- One delegate per task, one worktree per delegate, each in its own Herdr space: `coordinate delegate <name> --task "<few words>" --repo <path> --harness pi|claude ...` makes `<repo>/.claude/worktrees/<name>` on `<branch_prefix><name>`. `--cwd` is for a domain with no repo; `--no-space` puts it in a tab of your space. Invoking this skill is the user's request for these worktrees, branches and spaces.
- Brief it from [brief.md](references/brief.md) (`--brief`), or for a spec, start it with the implement skill: `--skill implement|implement-spec --args "<spec path>"` (the script writes `/implement` for Claude, `/skill:implement` for pi).
- Harness and model: the user's named choice wins; otherwise follow Standing yes; otherwise pick by the work (a cheap model for bounded mechanical edits, the strongest for design, debugging and new features) and say which in one line.
- Put the printed handle line in the backlog under the item. Done when the delegate shows a status and its handle is recorded.
- Send follow-ups with `coordinate send`, not `hc send`. Send no progress check-ins; the watcher tells you when a delegate settles. A permission dialog is the user's to answer in that tab: name the tab.
- A review session runs only when the user asks for one.

## Watch

Run exactly one watcher per domain, unawaited, and act on its output when it arrives:

```js
$`bun $SKILL_DIR/scripts/coordinate.ts watch`
  .timeout(7_200_000)
  .nothrow()
  .then((out) => log(out.stdout));
```

It exits on the first events, one line each, and keeps its snapshot so changes while it was down fire on re-arm. Handle every line, then arm it again. `alive` means nothing happened before its time limit; `blind` or `owner gone` means it lost sight of Herdr or of you. A `settled` line comes with a status beat: give the user a two-line status in your next reply.

## Verify, then report and wait

When a delegate settles, read its `REPORT.md` and verify before you tell the user: the diff stays inside the brief, the checks ran (a log and its exit status), no stop point was crossed. Every count, cause and PR state in a reply comes from a command run this turn, or is marked unverified. Then give the outcome and what waits on them, and wait for the user to name the integration (land locally, push, open a PR). Do that integration exactly as named.

A status question ("sitrep", "where are we") gets `coordinate status` and at most three lines of yours.

## Clean up

Sweep at Start, after compaction, when the watcher fires, and in the turn a task finishes (integrated, delivered, dismissed or parked). [sweep.md](references/sweep.md) says what each verdict asks of you. End delegates quiet for a day with `coordinate end --list-idle`; `coordinate resume <name>` brings one back when a review or answer arrives.

## Backlog

Shape, handle lines and Standing yes form: [backlog.md](references/backlog.md). Update it in the turn a state changes.

## Restart

Before a restart (`/clear` then `/coordinate <domain>`): close asks the backlog already answers, write every open item, handle and open ask (marked "open before restart") into the backlog, and stop the watcher. Reply "ready for restart". After it, run Start and raise those asks again within the five-ask limit.

## Compound

You see friction repeat. Note its first occurrence in the backlog; on the second, propose the skill, rule or script that removes it, or add it to the owning domain's backlog marked "from <domain>".
