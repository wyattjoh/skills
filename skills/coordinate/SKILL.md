---
name: coordinate
description: Runs this session as the coordinator for one domain (a project, product area or set of tools), routing each request to an answer, a small build, or a pi or Claude Code delegate in its own Herdr space. The user passes the domain as the argument.
argument-hint: "<domain>"
compatibility: Requires Git, hc and herdr-app inside a Herdr terminal (HC_TERMINAL_ID), gh for GitHub repos, forgejo for Forgejo repos, and pi or Claude Code for delegates.
disable-model-invocation: true
---

# Coordinate

Take the user's ideas, gripes, links and requests for one domain, often half-formed, and see each through, mostly by delegating, so this session stays free for the next item. The domain's **backlog** is your only memory across compaction and restarts. It is a structured document the `coordinate` CLI owns: you record every state change through `backlog`, `item` and `finding` commands and read it back with `coordinate backlog show`, never by editing a file. You are a router, not a pipeline: nothing here merges, lands, pushes or opens a PR unless the user names that integration for the item.

`coordinate` below means `bun $SKILL_DIR/scripts/coordinate.ts`. Its `--help` (and each subcommand's) is the manual for flags and output. Exit 0 is done, 1 is a refusal to act on, 2 is a check that could not run: fix what it prints and run it again. Use the `herdr` skill for any `hc` or `herdr-app` work the script does not cover.

## Start

Run `coordinate start <domain>`. It labels this terminal, creates the backlog document if missing, and prints status, the sweep report and quiet delegates. When it names a legacy Markdown backlog, that file is reference only: read it for context and record what still matters through the commands below. Then:

- **Boundary**: `coordinate backlog boundary add <path>` for each repo or folder the domain owns, `--adjacent` for the ones it reads but does not own. Only owned paths feed status, watch and sweep. Ask once when either list is unclear. Done when `backlog show` lists both and the user has seen them in two lines.
- Run `coordinate backlog show` and read every open item and finding. Set or refresh the domain's focus line with `coordinate backlog focus "<what the domain is doing now>"`. Arm the watcher (below).
- Report what finished, what waits on the user as self-contained asks, what runs, and what you take next.

After compaction or a restart, run `coordinate status --resume`; arm the watcher unless it prints `watcher running (pid N)`.

## Each item

A question gets an answer: read what it needs and reply. A change is an item:

1. Restate it in one line and name what it touches. Check its ripple: what depends on it, what it duplicates or contradicts, from the real files (or a subagent's conclusion).
2. Decide or ask (below), then route it: **answer**; **build** here when it fits one turn with no worktree, branch, running app or render to check; otherwise **delegate**.
3. Record what outlives the turn in the same turn (commands in [Backlog](#backlog)): `item add` for anything not finished this turn, then its status, decisions, ask or close.

**Drift test**, before each action: does it change something outside the boundary, or go past the item? Either yes: say "This moves into <X>, outside <domain>" and route it. Adjacent work is a delegated task with the user's yes for that repo. Another domain of the user's gets an item in that domain's backlog: `coordinate item add "<title> (from <domain>)" --domain <other>` (refused until that domain has run `coordinate start`). Other people's work stays theirs; raise it only when it blocks the domain.

## Decide or ask

**Decide** what sits inside the scope the user asked for and is reversible: say what you chose and why in one line, and go on. What their instructions, Standing yes or an item's decisions already approve is a decision too: take the step and cite it.

**Ask** when the answer changes what gets built, spends time or money they would notice, reaches anyone outside, is their taste, or their rules require their yes. A delegate's question is an ask even when you could decide it, unless the brief, their instructions, Standing yes or an item's decisions answer it; then answer and cite that. Search those first: an answer already given is a decision.

Each ask is self-contained in the reply and on its item: `coordinate item update <id> --status waiting-user --ask "<question>" --context "<why it came up>" --option "<label> :: <detail>" --rec <label> --why "<reason>"`. Repeat `--option` for each choice; omit ` :: <detail>` when it has no detail. Use only the label for `--rec` or when answering with `--answer`. The reply gives what, why, the options with consequences, and your recommendation. Batch asks into the next reply, most consequential first, five at most; the rest wait on their items. An ask a delegate is blocked on goes out at once. Record the user's answer with `item update <id> --answer "<their words>"` (it clears the ask and keeps the answer as a decision), then set the next status. A dismissed or unanswered ask stays open: absorb what they said and ask it again, revised. When an answer covers later cases, record it with `coordinate backlog standing add "<their words>"`.

## Delegate

- One delegate per task, one worktree per delegate, each in its own Herdr space: `coordinate delegate <name> --task "<few words>" --repo <path> --harness pi|claude ...` makes `<repo>/.claude/worktrees/<name>` on `<branch_prefix><name>`. `--cwd` is for a domain with no repo; `--no-space` puts it in a tab of your space. Invoking this skill is the user's request for these worktrees, branches and spaces.
- Brief it from [brief.md](references/brief.md) (`--brief`), or for a spec, start it with the implement skill: `--skill implement|implement-spec --args "<spec path>"` (the script writes `/implement` for Claude, `/skill:implement` for pi).
- Harness and model: the user's named choice wins; otherwise follow Standing yes; otherwise pick by the work (a cheap model for bounded mechanical edits, the strongest for design, debugging and new features) and say which in one line.
- Pass `--item <id>`: it is required from your terminal, and `coordinate delegate` records the delegate (name, session, branch, worktree, brief and report) on that item and sets it to delegated. A delegate starting a child review passes no `--item`. Done when the delegate shows a status and `backlog show` lists it under the item.
- Coordinator starts stop at `max_fleet_delegates` live delegates across domains (default `max(2, floor(cores / 4))`); `--over-budget` overrides the refusal. Child reviews count but are not refused.
- Brief only fast checks (format, lint, typecheck, unit tests, bundle). Name native or machine-heavy gates as "coordinator runs at landing"; the coordinator runs each once before landing.
- A delegate records what it notices outside its task with `coordinate finding add`; you close each finding with `coordinate finding close <id> --outcome "..."` (`--dismissed` when not acted on).
- Send follow-ups with `coordinate send`, not `hc send`. Send no progress check-ins; the watcher tells you when a delegate settles, and the delegate's `coordinate notify` line (from its brief's Report) wakes you too. A permission dialog is the user's to answer in that tab: name the tab.
- A review session runs only when the user asks for one. For a delegate's own review, give it the optional [Child review brief](references/brief.md): it runs `coordinate delegate` from its own terminal, so `HC_TERMINAL_ID` nests the read-only reviewer under that delegate, with its own brief.
- The delegate uses bounded `hc wait`, caps review rounds (default two), reads the child's report, then ends it with `coordinate end`; authorized integration waits for a ready verdict. When the delegate settles, the coordinator verifies the child's verdict too.

## Watch

Run exactly one watcher per domain and handle every line it prints. It keeps a snapshot, so changes while it was down fire when it is armed again. While no watcher runs and a delegate lives, every `coordinate` command you run says so on stderr (`status` on its first line): arm it at once.

- **Claude Code**: arm it with the Monitor tool, `timeout_ms: 1800000` and the command `bun $SKILL_DIR/scripts/coordinate.ts watch --follow --replace 2>&1`. Each event arrives as its own notification while it keeps running. Monitor stops it after 30 minutes: arm it again on the expiry notice, after `blind` or `owner gone`, and after an exit with no line. `stopped` means it was replaced or stopped on purpose: arm it again only when `coordinate status --resume` shows no watcher.
- **Elsewhere** (pi): run one-shot `watch` unawaited and act on its output when it arrives; it exits on the first events, so arm it again after handling them:

  ```js
  $`bun $SKILL_DIR/scripts/coordinate.ts watch`
    .timeout(7_200_000)
    .nothrow()
    .then((out) => log(out.stdout));
  ```

`alive` (one-shot only) means nothing happened before its time limit; `blind` or `owner gone` means it lost sight of Herdr or of you, and it exits: arm it again. A `settled` line comes with a status beat: give the user a two-line status in your next reply. An `answered <id>` line carries an answer recorded since the last check, by you or by the user outside this chat: read the item's decisions, set its next status, and unblock whoever waited on it.

## Verify, then report and wait

When a delegate settles, read its `REPORT.md` and verify before you tell the user: the diff stays inside the brief, the checks ran (a log and its exit status), no stop point was crossed. Every count, cause and PR state in a reply comes from a command run this turn, or is marked unverified. Then give the outcome and what waits on them, and wait for the user to name the integration (land locally, push, open a PR). Do that integration exactly as named.

A status question ("sitrep", "where are we") gets `coordinate status` and at most three lines of yours.

## Clean up

Sweep at Start, after compaction, when the watcher fires, and in the turn a task finishes (integrated, delivered, dismissed or parked). [sweep.md](references/sweep.md) says what each verdict asks of you. End delegates quiet for a day with `coordinate end --list-idle`, passing `--item-status` when the item is not done with it, so no item sits at `delegated` with no live delegate (`status` lists any that does); `coordinate resume <name>` brings one back when a review or answer arrives.

## Backlog

The CLI is the backlog's only writer; it validates, locks and writes atomically, and refuses a change that breaks an invariant (exit 1: fix the call and run it again). Record each state change in the turn it happens:

| State change                       | Command                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New work                           | `item add "<title>"` (prints its id, such as `i4`)                                                                                                                                |
| Building it here, parked, reopened | `item update <id> --status building\|parked\|open`                                                                                                                                |
| What it touches, a due date        | `item update <id> --touch <repo>`, `--due YYYY-MM-DD` (the watcher fires on that date)                                                                                            |
| A decision                         | `item update <id> --decided "<the user's words>"`                                                                                                                                 |
| An ask, its answer                 | `item update <id> --status waiting-user --ask ...`, then `--answer "<their words>"`; the user may answer from the Backlog panel instead (`item answer`)                           |
| Delegated                          | `delegate <name> --item <id> ...`                                                                                                                                                 |
| Its last delegate ended            | `end <name> --item-status open\|parked\|waiting-user\|building`; without it `end` prints the command, and `status` and `backlog show` flag a delegated item with no live delegate |
| A running session filed, unfiled   | `item attach <id> <delegate>`, `item detach <id> <delegate>` (name or address)                                                                                                    |
| Done or dismissed                  | `item close <id> --outcome "<one line>"` (`--dismissed`)                                                                                                                          |
| Standing yes, Boundary, focus      | `backlog standing add`, `backlog boundary add\|rm`, `backlog focus`                                                                                                               |
| The domain renamed                 | `backlog rename <new>` (`--domain <old>` from any terminal); refused while it has a live delegate or watcher                                                                      |
| A finding opened or closed         | `finding add --kind issue\|opportunity "<title>"`, `finding close <id> --outcome ...`                                                                                             |

The Backlog panel may edit Boundary paths from outside a Herdr terminal with `backlog boundary add <path> [--adjacent] --domain <d>` and `backlog boundary rm <path> --domain <d>`. Every command takes `--json`; `--help` has the flags. Read it back with `coordinate backlog show` (`--json` for the document). Fields, statuses and invariants: [backlog.md](references/backlog.md).

## Restart

Before a restart (`/clear` then `/coordinate <domain>`): answer or close what the backlog already resolves, make sure every open item, decision and ask is recorded (`backlog show` is what the next session sees), and stop the watcher (its Monitor, or `kill` the pid in `coordinate status --resume`). Reply "ready for restart". After it, run Start and raise the open asks again within the five-ask limit.

## Compound

You see friction repeat. Note its first occurrence with `coordinate finding add --kind opportunity`; on the second, propose the skill, rule or script that removes it, or add it to the owning domain's backlog with `item add "<title> (from <domain>)" --domain <other>`.
