# Brief

The brief is what a delegate reads first and the contract you verify against. Write it anywhere (your own `.scratch/` is fine) and pass it with `--brief`; `coordinate delegate` copies it to `<worktree>/.scratch/BRIEF.md`, or for a `--cwd` start to `<cwd>/.scratch/<name>/BRIEF.md`, so delegates sharing a folder keep their own brief and report. The report path, `<absolute report path>` below, is `REPORT.md` beside the copied brief. A different existing brief there is moved beside it under a unique name and that path is printed; byte-identical briefs need no backup. When wiki pages cover the delegate's repo or folder, `WIKI.md` beside the brief lists them and the first message points at it ([wiki.md](wiki.md#at-launch)), so the brief need not list them. Git ignores `.scratch/`. The worktree is always `<repo>/.claude/worktrees/<name>`, so you can write its absolute paths before it exists. When the repo declares worktree setup (`.claude/coordinate.json`, see Delegate in [SKILL.md](../SKILL.md#delegate)), it has already run when the delegate starts, so a brief need not tell the delegate to install dependencies; its output is in `.scratch/setup.log`.

Fill every required heading. Include Child review only when the user requested it. Quote the user where they decided something, so the delegate neither asks again nor widens it. For a Tasks MCP-backed implementation or review brief, including Child review, give the Spec or Task UUID directly, or export the Spec and its tickets to the delegate's `.scratch/spec.md` before launch and point to that file. Do not make delegates infer the Spec from another report.

When writing a real brief, replace `<absolute coordinate skill path>` with the actual absolute path to the installed coordinate skill, so the notification works even when `coordinate` is not on PATH.

```markdown
# Brief: <task in a few words>

You own <what>, on branch `<branch>` in `<absolute worktree path>`. Your coordinator is terminal
`<coordinator address>`. The user reads your terminal too.

Read first: <repo guides, the plan or spec, by absolute path>.

## Goal

<What done looks like, observable, in one or two sentences.>

## Decided

- <Decision>. The user, <date>: "<their words>".
- <Assumption made because asking would not change this brief.>

## Boundary

Change only <files, apps or areas>. Every uncommitted change in this delegate's worktree is yours, including changes made by your sub-agents. Write only inside this worktree. Anything else is a question
for the coordinator, not a change. Record an issue or opportunity you notice outside this task with
`coordinate finding add "<title>" --kind issue|opportunity --from <item id> --detail-md "<detail>"`.
The detail is Markdown with **What** (the problem or opportunity), **Where** (files, commands or screens), **Why it matters** and **Suggested fix**, plus evidence (a command, log path or commit) when there is one; keep it short when the finding is small.

## Stop points

Commit your work on `<branch>` once <the checks, each by command> pass. Do not push, open or merge a
PR, or land anything: the coordinator integrates when the user names how.
Stop and report before bumping a version, releasing, messaging a person, changing CI or
infrastructure, a second round of measurement, and after two failed attempts at the final verification of one check.
A version bump means the version this repo publishes; updating a dependency pin the task asks for is not one.
The final verification is the run that gates your commit; red tests while you develop are not attempts.
A lock timeout or a model usage-limit error is not a failed attempt: wait and retry.
When the repo has one gate script, name only it: in wyattjoh/skills that is `bun run verify`, which runs the same checks as its pre-push hook and CI.
List only fast checks (format, lint, typecheck, unit tests, bundle). Name native or machine-heavy gates as "coordinator runs at landing"; the coordinator runs each once before landing. Add task-specific stop points, including choices the user still has to make.

## Follow-up rounds

When a round is independent of the delegate's live session and its `REPORT.md` is current, start a fresh agent in the same worktree and hand it the report plus a new brief: `coordinate delegate <new name> --item <id> --worktree <worktree> --harness pi|claude --brief <new brief>`. This records the new session, existing branch and worktree, brief, and report on the item. The existing worktree must be a linked worktree, and no live delegate may already use it. The brief copy rules still apply, so a different existing `BRIEF.md` is moved aside and an identical one is kept. Setup is not rerun for an existing worktree. Resume the existing session or use `coordinate send` when the round depends on live state.

## Child review

After committing and passing checks, write `<absolute child brief path>`: review
`git diff <review base>...<delegate branch>` against <requirements>; read-only, writes only to
its own `.scratch/`, no source edits, commits or remote writes. Require a report with findings, checks
(command, log, exit status), and a ready / needs changes verdict.

From your own terminal, run `coordinate delegate <child name> --domain <domain> --task "<review task>" --repo <absolute repo path> --base <delegate branch> --harness <pi|claude> [--model <verified-model>] --brief <absolute child brief path>`. Omit `--model` by default. Never pass a specific model until its availability is verified for the chosen harness; for pi, verify an explicit model ID with `pi --list-models`. An ordinary pi launch omits both `--model` and `--provider` so pi keeps its default `auto` model. Pass an explicit model only for a concrete reason after that check.
Wait with `hc wait <child terminal address from the "started" line> --timeout <seconds, e.g. 900>`, at most
<wait count, e.g. 4> times per round. Read the child's report; fix findings and use
`coordinate send <child name> "<what changed; re-review the delegate branch>"` if needed.
Cap at <round cap, default 2> rounds. If either bound is exhausted without a ready verdict, stop
and report without integrating. After reading its final report, end the child with `coordinate end <child name>`.
Integrate only as authorized in Stop points and only after a ready verdict.
Include the child's name, terminal address and session id, rounds, final verdict and report path in your report for coordinator verification.

## Report

Whenever you stop, write `<absolute report path>` with:

- status: done, waiting on the user's yes, or stopped on a question
- what changed: files and commits
- what you verified and how: the command, the log path, the exit status
- each open question, with your recommendation
- made outside the worktree: processes (PID, port), folders, simulators, other worktrees,
  each with how to remove it, or "nothing"

Then run `bun <absolute coordinate skill path>/scripts/coordinate.ts notify "<name>: <status>, report at <absolute report path>"`
to wake the coordinator, and end your turn with the same summary. A refused or failed notify does not
stop you ending the turn: the coordinator's watcher still fires.
```

## Remote delegates (the delegate outbox variant)

A delegate started with `--machine` runs where there is no coordinate CLI, so it cannot run `coordinate finding add` or `coordinate notify`. Write the brief exactly as above; `coordinate delegate` appends this section to the copy it writes on that machine, with `<outbox>` the absolute path of `.scratch/OUTBOX.jsonl` in the delegate's worktree there. Local briefs are copied unchanged.

```markdown
## Delegate outbox

This delegate runs on <machine>, which has no coordinate CLI. Do not run `coordinate finding add` or `coordinate notify`: wherever this brief says to run one, append one JSON object on its own line to `<outbox>` instead, and never change earlier lines. Your coordinator's watcher reads the file and applies each line once.

- A finding: `{"type":"finding","kind":"issue","title":"<title>","from":"<item id>","detailMarkdown":"<what, where, why it matters, suggested fix>","path":"<file or folder>"}`. `kind` is `issue` or `opportunity`. `detailMarkdown` is required (newlines as `\n`): Markdown with **What** (the problem or opportunity), **Where** (files, commands or screens), **Why it matters** and **Suggested fix**, plus evidence (a command, log path or commit) when there is one; keep it short when the finding is small; a line without it is skipped. `from` and `path` are optional; plain-text `detail` is deprecated.
- The notify: `{"type":"notify","text":"<name>: <status>, report at <absolute report path>"}`.
```

The domain watcher reads each remote delegate's delegate outbox every tick through `hc file read --on`, applies only newline-terminated lines, and remembers per session how many it has applied, so a restarted watcher or a resumed delegate never applies a line twice. A finding line becomes an open finding with source `delegate:<name>`; a notify line wakes the coordinator as a `notify` event; a line it cannot apply (not JSON, an unknown `type`, a missing field such as a finding's `detailMarkdown`, or a refused finding) is skipped with a `delegate-outbox-invalid` event naming its line number. A backlog that cannot be written leaves the line for the next tick. A `--skill` launch with no `--brief` writes no brief, so it gets no Delegate outbox section: give a remote skill launch a `--brief`.

With `--skill`, the skill and its `--args` carry the task (for an implement skill, the spec or ticket carries the goal): point Goal at them and keep Decided, Boundary, Stop points and Report. `implement-spec` builds on an integration branch of its own, with a worktree per ticket and ticket updates in the tracker: name the delegate's branch as that branch, let Boundary allow those ticket worktrees and tracker updates, and say in Stop points that they override the skill's draft PR step unless the user named a PR.

When the user named an integration for this task up front (say, "push and open a PR when green"), replace the first stop-point paragraph with that instruction in their words.
