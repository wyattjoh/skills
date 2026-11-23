---
name: coordinate
description: Runs this session as the coordinator for one domain (a project, product area or set of tools), routing each request to an answer, a small build, or a pi or Claude Code delegate in its own Herdr space. The user passes the domain as the argument.
argument-hint: "<domain>"
compatibility: Requires Git, hc and herdr-app inside a Herdr terminal (HC_TERMINAL_ID), gh for GitHub repos, forgejo for Forgejo repos, and pi or Claude Code for delegates.
disable-model-invocation: true
---

# Coordinate

Take the user's ideas, gripes, links and requests for one domain, often half-formed, and see each through, mostly by delegating, so this session stays free for the next item. The domain's **backlog** is your only memory across compaction and restarts. It is a structured document the `coordinate` CLI owns: you record every state change through `backlog`, `item` and `finding` commands and read it back with `coordinate backlog show`, never by editing a file. You are a router, not a pipeline: nothing here merges, lands, pushes or opens a PR unless the user names that integration for the item.

`coordinate` below means `bun $SKILL_DIR/scripts/coordinate.ts`. Its `--help` (and each subcommand's) is the manual for flags and output. Exit 0 is done, 1 is a refusal to act on, 2 is a check that could not run: fix what it prints and run it again. Text backlog views hide closed items by default; use `coordinate backlog show --done` or `coordinate status --resume --done` to include them. Answered asks render as `answered (<date>): <question> → <answer>`; `--verbose` on `backlog show` or `status --resume` restores full context, options and recommendation. Pending asks stay fully rendered, and `--json` output is unchanged. Use the `herdr` skill for any `hc` or `herdr-app` work the script does not cover.

## Start

Run `coordinate start <domain>`. It labels this terminal, creates the backlog document if missing, and prints status, the sweep report and quiet delegates. When it names a legacy Markdown backlog, that file is reference only: read it for context and record what still matters through the commands below. Then:

- **Boundary**: `coordinate backlog boundary add <path>` for each repo or folder the domain owns, `--adjacent` for the ones it reads but does not own. Only owned paths feed status, watch and sweep. Ask once when either list is unclear. Done when `backlog show` lists both and the user has seen them in two lines.
- Run `coordinate backlog show` and read every open item and finding. Add `--done` when closed-item history is relevant. Set or refresh the domain's focus line with `coordinate backlog focus "<what the domain is doing now>"`. `coordinate start` arms the watcher; if it reports `watcher unavailable`, use the Watch fallback below.
- Report what finished, what waits on the user as self-contained asks, what runs, and what you take next.

After compaction or a restart, run `coordinate status --resume`; add `--done` when closed-item history is relevant. It arms the watcher when none runs. If it reports `watcher unavailable`, use the Watch fallback below.

## Each item

A question gets an answer: read what it needs and reply. A change is an item:

1. Restate it in one line and name what it touches. Check its ripple: what depends on it, what it duplicates or contradicts, from the real files (or a subagent's conclusion).
2. Decide or ask (below), then route it: **answer**; **build** here when it fits one turn with no worktree, branch, running app or render to check; otherwise **delegate**.
3. Record what outlives the turn in the same turn (commands in [Backlog](#backlog)): `item add` for anything not finished this turn, then its status, decisions, ask or close.

**Drift test**, before each action: does it change something outside the boundary, or go past the item? Either yes: say "This moves into <X>, outside <domain>" and route it. Adjacent work is a delegated task with the user's yes for that repo. Another domain of the user's gets an item in that domain's backlog: `coordinate item add "<title> (from <domain>)" --domain <other>` (refused until that domain has a backlog, which `coordinate start` or `coordinate spawn` creates). Other people's work stays theirs; raise it only when it blocks the domain.

## Decide or ask

**Decide** what sits inside the scope the user asked for and is reversible: say what you chose and why in one line, and go on. What their instructions, a policy or an item's decisions already approve is a decision too: take the step and cite it.

**Ask** when the answer changes what gets built, spends time or money they would notice, reaches anyone outside, is their taste, or their rules require their yes. A delegate's question is an ask even when you could decide it, unless the brief, their instructions, an existing policy or an item's decisions answer it; then answer and cite that. Search those first: an answer already given is a decision.

Each question reaches the user through one channel, chosen when you raise it. A **backlog ask** fits an answer that can wait, or one the user may give from the Backlog panel or another session. A **question tool** prompt (`AskUserQuestion` in Claude Code) fits an answer you need now, in this conversation. A question raised in one channel stays out of the other.

A backlog ask is recorded on an item in the turn you raise it; the Backlog panel's Waiting On You list shows it and takes its answer. A question with no item gets one first (`item add`). Record it with `coordinate item update <id> --status waiting-user --ask "<question>" --context "<why it came up>" --option "<label> :: <detail>" --rec <label> --why "<reason>"`. Repeat `--option` for each choice; omit ` :: <detail>` when it has no detail. Use only the label for `--rec` or when answering with `--answer`. The reply mirrors each backlog ask, self-contained: what, why, the options with consequences, and your recommendation. Record the user's answer with `item update <id> --answer "<their words>" [--note "<note>"]` (it clears the ask and keeps the answer as a decision; `--note` records accompanying context), then set the next status. If the user asks to discuss instead, record `Discuss` or `Discuss: <note>`; keep the ask open and the item waiting-user until they give an actual answer.

A question tool prompt carries no `--ask`. In the turn the user answers, record their choice on its item with `item update <id> --decided "<question>: <their words>"`, so the backlog still holds it; a question with no item gets one first.

Batch questions, most consequential first, five at most; the rest wait as backlog asks on their items. A question a delegate is blocked on goes out at once. A dismissed or unanswered question stays open in its channel: absorb what they said and ask it again there, revised. When an answer establishes a reusable rule for later cases, formulate it as a policy and record that with `coordinate backlog policy add "<policy>"`.

## Delegate

- One delegate per task, one worktree per delegate, each in its own Herdr space: `coordinate delegate <name> --task "<few words>" --repo <path> --harness pi|claude ...` makes `<repo>/.claude/worktrees/<name>` on `<branch_prefix><name>`. `--cwd` is for a domain with no repo; `--no-space` puts it in a tab of your space. Invoking this skill is the user's request for these worktrees, branches and spaces.
- Brief it from [brief.md](references/brief.md) (`--brief`). To implement a spec or ticket, start it with an implement skill as well: both are user-invoked, so they reach the delegate only as its first message. Pass `--skill implement-spec` for a spec, `--skill implement` for a single ticket, with `--args "<ref>. <rest>"` (the script writes `/implement-spec` for Claude, `/skill:implement-spec` for pi). For a Tasks MCP UUID, look it up in the Tasks MCP to tell a Spec from a Task, and make `<ref>` `<UUID> via Tasks MCP`; for a file, `<ref>` is its path. `<rest>` is the user's request condensed, plus the item's decisions and the policies that bind the delegate. Pass `--brief` alongside it with Boundary, Stop points and Report filled; the first message then tells the delegate to follow those sections. A copied brief replaces `<worktree>/.scratch/BRIEF.md` (for `--cwd`, `<cwd>/.scratch/<name>/BRIEF.md`, so delegates sharing a folder keep their own; the report sits beside it); a different existing brief is moved beside it under a unique name and that path is printed. Byte-identical briefs need no backup.
- Harness and model: only Pi and Claude are supported. Pass `--harness pi|claude`, unless the effective policy has an enabled default; an explicit disabled harness is refused. `coordinate start` and `coordinate status --resume` show effective policy. Policy edits affect later launches and resumes, not running sessions. A resume uses its recorded harness and refuses when that harness is disabled. `--over-budget` never bypasses harness policy. See [harness-policy.md](references/harness-policy.md) for policy commands and the full contract. The Backlog panel's header cog opens a settings window on the global defaults (on Domains) or the current domain (on a domain page), with an Inherit global switch per domain; Save writes the changes through these CLI commands and revision checks. Never pass a specific model until its availability is verified for the chosen harness. For pi, omit `--model` and `--provider` on ordinary launches so pi keeps its default `auto` model; pass an explicit model only for a concrete reason after verifying its ID with `pi --list-models`. Say the choice in one line.
- Pass `--item <id>`: it is required from your terminal, and `coordinate delegate` records the delegate (name, session, branch, worktree, brief and report) on that item and sets it to delegated. A delegate starting a child review passes no `--item`. Done when the delegate shows a status and `backlog show` lists it under the item.
- Coordinator starts stop at each target machine's per-machine budget, defaulting to `max(2, floor(machine cores / 4))`; `max_fleet_delegates` sets the default and `max_fleet_delegates_by_machine` overrides by Herdr machine name (`local` for this host). Delegates on other machines do not count, `--over-budget` overrides only the capacity refusal, and child reviews count but are not refused by that capacity gate.
- When an authorized launch hits the cap and should wait, repeat the same command with `--queue-if-full`, for example `coordinate delegate fix-login --task "fix login" --repo <repo> --harness pi --brief <brief> --item i4 --queue-if-full`. This writes only the item id, target machine and enqueue order. It never stores the inline message, options or argv, and it starts no delegate. The domain watcher checks live delegate capacity across domains on that machine, including settled delegates whose terminals remain live, and wakes the coordinator for the oldest eligible item in this domain's queue per machine. It does not start work itself.
- On a capacity wake, inspect the current item and reconstruct the original authorized launch from the current conversation and its brief. Retry with the original launch flags plus `--retry-queued` and the original `--harness` explicitly, for example `coordinate delegate fix-login --task "fix login" --repo <repo> --harness pi --brief <brief> --item i4 --retry-queued`. The command rechecks current harness policy, verifies this is the oldest eligible item, and rechecks the regular budget before starting. If policy or capacity refuses the retry, the item stays queued and the watcher wakes again when capacity returns. A successful start removes the queue entry; a stale wake for a removed entry is ignored.
- Queue metadata cannot reconstruct launch context after restart. Recover each required option and the prior authorization from the backlog, brief and available conversation; if anything needed is missing, surface that and ask rather than guessing or launching. Closing or dismissing the item removes its queue entry on the next watcher tick. Items waiting on the user or parked stay queued but are not monitored for capacity until they become active again.
- Brief only fast checks (format, lint, typecheck, unit tests, bundle). Name native or machine-heavy gates as "coordinator runs at landing"; the coordinator runs each once before landing.
- A delegate records what it notices outside its task with `coordinate finding add`; you close each finding with `coordinate finding close <id> --outcome "..."` (`--dismissed` when not acted on).
- Send follow-ups with `coordinate send`, not `hc send`. Send no progress check-ins; the watcher tells you when a delegate settles, and the delegate's `coordinate notify` line (from its brief's Report) wakes you too. A permission dialog is the user's to answer in that tab: name the tab.
- A review session runs only when the user asks for one. For a delegate's own review, give it the optional [Child review brief](references/brief.md): it runs `coordinate delegate` from its own terminal, so `HC_TERMINAL_ID` nests the read-only reviewer under that delegate, with its own brief.
- The delegate uses bounded `hc wait`, caps review rounds (default two), reads the child's report, then ends it with `coordinate end`; authorized integration waits for a ready verdict. When the delegate settles, the coordinator verifies the child's verdict too.

## Spawn

`coordinate spawn <domain>` starts a coordinator for a domain, where `delegate` starts a worker on one item. Any coordinator may run it, for example to give work outside its boundary its own owner; the manager runs it only on the user's explicit ask ([manage.md](references/manage.md)). It is refused from a delegate, an unlabelled terminal, or a plain shell outside Herdr. Before launching, it seeds that domain's backlog: it creates the backlog if missing, adds `--cwd` to its owned Boundary, and adds each `--item "<title>"` (repeatable) as an open item, unless an item not yet closed already has that title, which it reports as already present. Without `--cwd` it starts in the existing backlog's first owned Boundary path, and refuses when there is none. It launches `<domain>-coordinator` (a `.` becomes `-`, and a long domain is shortened with a hash) in its own unfocused space, tab `<Domain> · No active focus`, with no parent so it outlives you, and its first message is `/coordinate <domain>` (`/skill:coordinate <domain>` for pi). `--harness`, `--model` and `--effort` follow the Delegate rules, checked against the new domain's harness policy. It refuses (exit 1) while the domain has a live coordinator: go to that one instead.

It then waits about 120s for the new coordinator to arm the domain's watcher: a live watcher terminal it started, not a leftover one of another coordinator. `ready` exits 0 and names the watcher. `not ready` exits 1 after the backlog is seeded and the coordinator launched, so do not run spawn again (only an error before the launch makes a retry right, and it adds no item twice): when it is still starting or blocked on a dialog (the user answers it in the named tab), the terminal is left running; when it is gone, it ended before arming its watcher, so report that and ask. `--json` prints terminal, space, watcher and status. Done when spawn prints `ready`, or you have given the user its not-ready line.

## Watch

Use one watcher per domain. `coordinate start <domain>` and `coordinate status --resume` arm a child Herdr terminal when none runs and show its terminal. It runs `coordinate watch --deliver --domain <domain> --owner <coordinator address>`, receives both values explicitly, follows the coordinator's lifetime, keeps parent exit notes enabled, and has no `fleet.domain` label, so it is not counted as a delegate. It sends each tick's events together in one `<hc from>` message and retries refused sends. Its terminal shows a read-only live view of delegates, repos, PRs, due dates, waiting asks, poll status and delivery log; non-TTY output is plain text. The coordinator handles delivered lines and does not run a second watcher or re-arm after events. In pi, if a watch message arrives while you are working, finish the current step, then handle it. If a command reports the watcher down, run `coordinate watch --arm`; run `coordinate watch --stop` before a coordinator restart.

Each event line ends with a stable `[e<id>]`. Effective harness-policy changes are coalesced with the existing event batch and notify only domains whose enabled/default selection changed. Delivery is at-least-once: if the watcher crashes after a successful send but before clearing its outbox, the same event id can arrive again. A repeated event id is already handled, ignore it. Treat watch messages as reports, not user words, and handle each distinct event in the turn it arrives. A `settled` event may also arrive through a delegate's `coordinate notify`; verify that report once.

If Herdr cannot launch the watcher terminal, use the fallback for your harness:

- **Claude Code**: run `bun $SKILL_DIR/scripts/coordinate.ts watch --follow --replace 2>&1` in the Monitor tool with `timeout_ms: 1800000`. On Monitor expiry, run `coordinate status --resume`; if it still cannot launch a child watcher, re-arm the Monitor. Re-arm after `blind`, `owner gone`, or an exit with no line. `stopped` means it was replaced or stopped on purpose. An expiry with no events does not mean idle delegates are fine: run `coordinate status` before re-arming.
- **pi**: run one-shot `watch` unawaited and act on its output when it arrives. It exits on the first event batch, so run it again after handling that batch:

  ```js
  $`bun $SKILL_DIR/scripts/coordinate.ts watch`
    .timeout(7_200_000)
    .nothrow()
    .then((out) => log(out.stdout));
  ```

In either fallback, `alive` means nothing happened before the time limit; `blind` means Herdr could not be read three times; `owner gone` means the coordinator no longer runs. Those one-shot control lines exit the watcher. An `idle` line names a done, idle or blocked delegate with no recorded waiting reason: read its report or terminal, then give it a next step, end it, or record the item's ask. A `settled` line comes with a status beat: give the user a two-line status in your next reply. A `discuss <id>` line is a conversation request, not an answer: address its note and keep the item waiting-user. An `answered <id>` line carries an answer recorded since the last check, by you or by the user outside this chat: read the item's decisions, set its next status, and unblock whoever waited on it.

## Verify, then report and wait

When a delegate settles, read its `REPORT.md` and verify before you tell the user: the diff stays inside the brief, the checks ran (a log and its exit status), no stop point was crossed. Every count, cause and PR state in a reply comes from a command run this turn, or is marked unverified. Then give the outcome and what waits on them, and wait for the user to name the integration (land locally, push, open a PR). Do that integration exactly as named. Before you end a turn, run `coordinate status`. Every live delegate that is done or idle gets a next step, an `end`, or an item at `waiting-user` carrying the ask. An open ask blocks only its own item: take the reversible in-worktree step you recommend, say so in one line, and let the user overrule. Then apply the domain's policies for open items.

A status question ("sitrep", "where are we") gets `coordinate status` and at most three lines of yours.

## Clean up

Sweep at Start, after compaction, when the watcher fires, and in the turn a task finishes (integrated, delivered, dismissed or parked). [sweep.md](references/sweep.md) says what each verdict asks of you. `coordinate end` also stops what the delegate left running, its terminal's process tree and the orphans left in the worktree `delegate --repo` made for it, and prints each one. End delegates quiet for a day with `coordinate end --list-idle`, passing `--item-status` when the item is not done with it, so no item sits at `delegated` with no live delegate (`status` lists any that does); `coordinate resume <name>` brings one back when a review or answer arrives.

## Backlog

The CLI is the backlog's only writer; it validates, locks and writes atomically, and refuses a change that breaks an invariant (exit 1: fix the call and run it again). Record each state change in the turn it happens:

| State change                       | Command                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New work                           | `item add "<title>"` (prints its id, such as `i4`)                                                                                                                                                                                                                |
| Building it here, parked, reopened | `item update <id> --status building\|parked\|open`                                                                                                                                                                                                                |
| What it touches, a due date        | `item update <id> --touch <repo>`, `--due YYYY-MM-DD` (the watcher fires on that date)                                                                                                                                                                            |
| A decision                         | `item update <id> --decided "<the user's words>"`, including a question tool answer                                                                                                                                                                               |
| An ask, discussion or answer       | `item update <id> --status waiting-user --ask ...`; use `--answer "Discuss"` or `--answer "Discuss: <note>"` to request a conversation, then record the actual answer with `--answer "<their words>"`; the user may answer from the Backlog panel (`item answer`) |
| Delegated                          | `delegate <name> --item <id> ...`                                                                                                                                                                                                                                 |
| Its last delegate ended            | `end <name> --item-status open\|parked\|waiting-user\|building`; without it `end` prints the command, and `status` and `backlog show` flag a delegated item with no live delegate                                                                                 |
| A running session filed, unfiled   | `item attach <id> <delegate>`, `item detach <id> <delegate>` (name or address)                                                                                                                                                                                    |
| Done or dismissed                  | `item close <id> --outcome "<one line>"` (`--dismissed`)                                                                                                                                                                                                          |
| Policies, Boundary, focus          | `backlog policy add\|ls\|rm\|replace`, `backlog boundary add\|rm`, `backlog focus`                                                                                                                                                                                |
| The domain renamed                 | `backlog rename <new>` (`--domain <old>` from any terminal); refused while it has a live delegate or watcher                                                                                                                                                      |
| A finding opened or closed         | `finding add --kind issue\|opportunity "<title>"`, `finding close <id> --outcome ...`                                                                                                                                                                             |

The Backlog panel may edit Boundary paths from outside a Herdr terminal with `backlog boundary add <path> [--adjacent] --domain <d>` and `backlog boundary rm <path> --domain <d>`. Every command takes `--json`; `--help` has the flags. Read it back with `coordinate backlog show` (`--json` for the document, `--done` to include closed items). Fields, statuses and invariants: [backlog.md](references/backlog.md).

## Manage the fleet

The `manager` domain coordinates the other coordinators instead of a repo: it watches the fleet, relays their asks and results, keeps tab titles aligned with each focus, tells harness handoffs from crashes, and spawns a coordinator only when the user asks for it. When the user names that role, read [manage.md](references/manage.md) and run its fleet monitor, `bun $SKILL_DIR/scripts/fleet-monitor.ts`.

## Restart

Before a restart (`/clear` then `/coordinate <domain>`): answer or close what the backlog already resolves, make sure every open item, decision and ask is recorded (`backlog show` is what the next session sees), and run `coordinate watch --stop`. Reply "ready for restart". After it, run Start and raise the open asks again within the five-ask limit.

## Compound

You see friction repeat. Note its first occurrence with `coordinate finding add --kind opportunity`; on the second, propose the skill, rule or script that removes it, or add it to the owning domain's backlog with `item add "<title> (from <domain>)" --domain <other>`.
