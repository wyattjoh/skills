# Brief

The brief is what a delegate reads first and the contract you verify against. Write it anywhere (your own `.scratch/` is fine) and pass it with `--brief`; `coordinate delegate` copies it to `<worktree>/.scratch/BRIEF.md` and Git ignores `.scratch/`. The worktree is always `<repo>/.claude/worktrees/<name>`, so you can write its absolute paths before it exists.

Fill every required heading. Include Child review only when the user requested it. Quote the user where they decided something, so the delegate neither asks again nor widens it.

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

Change only <files, apps or areas>. Write only inside this worktree. Anything else is a question
for the coordinator, not a change. Record an issue or opportunity you notice outside this task with
`coordinate finding add "<title>" --kind issue|opportunity --from <item id> --detail "<what>"`.

## Stop points

Commit your work on `<branch>` once <the checks, each by command> pass. Do not push, open or merge a
PR, or land anything: the coordinator integrates when the user names how.
Stop and report before bumping a version, releasing, messaging a person, changing CI or
infrastructure, a second round of measurement, and after two failed attempts at the final verification of one check.
A version bump means the version this repo publishes; updating a dependency pin the task asks for is not one.
The final verification is the run that gates your commit; red tests while you develop are not attempts.
A lock timeout or a model usage-limit error is not a failed attempt: wait and retry.
List only fast checks (format, lint, typecheck, unit tests, bundle). Name native or machine-heavy gates as "coordinator runs at landing"; the coordinator runs each once before landing. Add task-specific stop points, including choices the user still has to make.

## Child review

After committing and passing checks, write `<absolute child brief path>`: review
`git diff <review base>...<delegate branch>` against <requirements>; read-only, writes only to
its own `.scratch/`, no source edits, commits or remote writes. Require a report with findings, checks
(command, log, exit status), and a ready / needs changes verdict.

From your own terminal, run `coordinate delegate <child name> --domain <domain> --task "<review task>" --repo <absolute repo path> --base <delegate branch> --harness <pi|claude> --model <model> --brief <absolute child brief path>`.
Wait with `hc wait <child terminal address from the "started" line> --timeout <seconds, e.g. 900>`, at most
<wait count, e.g. 4> times per round. Read the child's report; fix findings and use
`coordinate send <child name> "<what changed; re-review the delegate branch>"` if needed.
Cap at <round cap, default 2> rounds. If either bound is exhausted without a ready verdict, stop
and report without integrating. After reading its final report, end the child with `coordinate end <child name>`.
Integrate only as authorized in Stop points and only after a ready verdict.
Include the child's name, terminal address and session id, rounds, final verdict and report path in your report for coordinator verification.

## Report

Whenever you stop, write `<absolute worktree path>/.scratch/REPORT.md` with:

- status: done, waiting on the user's yes, or stopped on a question
- what changed: files and commits
- what you verified and how: the command, the log path, the exit status
- each open question, with your recommendation
- made outside the worktree: processes (PID, port), folders, simulators, other worktrees,
  each with how to remove it, or "nothing"

Then run `coordinate notify "<name>: <status>, report at <absolute worktree path>/.scratch/REPORT.md"`
to wake the coordinator, and end your turn with the same summary. A refused or failed notify does not
stop you ending the turn: the coordinator's watcher still fires.
```

When the user named an integration for this task up front (say, "push and open a PR when green"), replace the first stop-point paragraph with that instruction in their words.
