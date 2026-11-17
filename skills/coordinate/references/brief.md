# Brief

The brief is what a delegate reads first and the contract you verify against. Write it anywhere (your own `.scratch/` is fine) and pass it with `--brief`; `coordinate delegate` copies it to `<worktree>/.scratch/BRIEF.md` and Git ignores `.scratch/`. The worktree is always `<repo>/.claude/worktrees/<name>`, so you can write its absolute paths before it exists.

Fill every heading. Quote the user where they decided something, so the delegate neither asks again nor widens it.

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
for the coordinator, not a change.

## Stop points

Commit your work on `<branch>` once <the checks, each by command> pass. Do not push, open or merge a
PR, or land anything: the coordinator integrates when the user names how.
Stop and report before bumping a version, releasing, messaging a person, changing CI or
infrastructure, a second round of measurement, and after two failed attempts at one check.
<Task-specific stop points, including choices the user still has to make.>

## Report

Whenever you stop, write `<absolute worktree path>/.scratch/REPORT.md` with:

- status: done, waiting on the user's yes, or stopped on a question
- what changed: files and commits
- what you verified and how: the command, the log path, the exit status
- each open question, with your recommendation
- made outside the worktree: processes (PID, port), folders, simulators, other worktrees,
  each with how to remove it, or "nothing"

Then end your turn with the same summary, so the coordinator's watcher fires.
```

When the user named an integration for this task up front (say, "push and open a PR when green"), replace the first stop-point paragraph with that instruction in their words.
