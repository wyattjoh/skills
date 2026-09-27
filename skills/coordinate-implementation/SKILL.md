---
name: coordinate-implementation
description: Coordinates local spec and ticket implementation through Pi or Claude Code workers in Herdr, with parallel implementation, per-ticket review, and serial integration onto a dedicated run branch. Use for "/coordinate-implementation", "implement the tickets in", "orchestrate the run", or "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>]"
compatibility: Requires Git, a Herdr-managed pane, the herdr skill, and the chosen worker harnesses (Pi or Claude Code).
disable-model-invocation: true
user-invocable: true
---

# Coordinate implementation

You are the coordinator. Delegate implementation and review to Herdr workers;
you own scheduling, decisions, the handoff record, and serial fast-forward
merges. Do not implement tickets or resolve their rebase conflicts yourself.
There is no detached workflow runtime. Keep supervising while work can advance;
if you exit, workers may finish their assignments, but coordination waits for
an explicit resume.

Load the `herdr` skill for session control and follow repository instructions.
Use the installed CLI for syntax and supported harness/model/effort options,
not remembered launch commands. Work inside Herdr, identify your own pane from
caller context, and never use the user's focused pane as your identity.

Arguments: `$ARGUMENTS`. Accept a local run folder or `resume <folder>` and
preferences in plain language. If resuming, start with [Resume](#resume).

## Prepare

1. Read `<run>/spec.md` and `issues/NN-*.md`, including acceptance criteria and
   `Blocked by:` relationships. Resolve missing tickets, ambiguous dependencies,
   and cycles before launching. Importing tickets or writing to a tracker is
   outside this skill. Verify the run folder is Git-ignored and accessible
   from every worktree; use absolute artifact paths in worker briefs.
2. Read project instructions and CI to establish worktree tooling, branch
   naming, setup, checks, commit policy, and cleanup. Reuse those commands;
   do not invent a parallel gate system or bypass a required tool.
3. Ask for missing preferences together: starting local branch, dedicated run
   branch and its integration worktree, ticket worktree location, implementor
   and reviewer harness/model/effort defaults, and a positive concurrency cap.
   Discover supported configurations without launching a worker. Never silently
   substitute an unavailable harness, model, or effort. The coordinator is the
   current session; it has no required harness or model binding.
4. Obtain approval for that configuration and the ticket branches/worktrees it
   entails. This covers routine setup within those bounds, subject to project
   rules, not remote writes or trunk integration. Create the run branch and
   its own worktree from the agreed starting point; do not use trunk as the
   integration branch or disturb an existing checkout.
5. Create `RESUME.md` using [resume.md](references/resume.md). Record resolved
   commands, approvals, defaults, and paths, not placeholders. Only you update
   this shared record. Persist decisions and next actions as they happen,
   especially before launches, merges, or ending a turn.

## Run the frontier

Tickets are a dependency graph, not a checklist to execute in file order. A
ticket is ready only when all its blockers have landed on the run branch.
Launch ready tickets up to the cap. Each ticket holds one slot from launch
through review, fixes, and landing; reviewers do not occupy separate slots.
A blocked ticket releases its slot, and must reacquire one before work resumes.
An empty frontier with unfinished tickets is blocked, not complete.

Give each implementor its own branch and worktree from the current run branch
and its own Herdr tab. Record the actual branch, worktree, session identity,
and harness/model/effort before sending work. Keep user focus unchanged. Use
short briefs with pointers rather than duplicating the spec:

- Read the ticket, spec, applicable project instructions, and recorded decisions.
- Implement only this ticket. Use TDD where appropriate at the agreed seams.
- Run repository-required checks, inspect your diff, and commit following project policy.
- Return a concise result naming the commit, check commands and outcomes,
  remaining concerns, and any blocking question. Do not launch a separate review,
  merge the run branch, push, or write to trackers.

Collect results and review findings in the run folder, linked from RESUME.md.
Use supported report or message surfaces; if a worker cannot write a report,
collect its returned findings and save them yourself. Do not reconstruct a
long report from wrapped or truncated terminal output.

## Review and integrate

Implementation, checks, and review may proceed in parallel. Only merges are
serial, performed by you in the integration worktree.

1. After implementation and required checks pass, launch **one fresh reviewer**
   using the approved reviewer default. It checks both repository **Standards**
   and the ticket/spec requirements against the ticket diff from the run branch.
   Give it the exact head and base commits, source pointers, and check results.
   Keep the implementor idle while that head is reviewed. The reviewer is
   read-only and must not delegate another review. It verifies check evidence
   and may rerun safe checks where needed. Record its verdict against those commits.
2. Require actionable findings with severity, location, and reasoning. Send
   medium-or-higher findings to the same implementor, then review the fixes.
   Record low-severity suggestions without making them automatic blockers.
   If fixes stop converging, inspect the cause and escalate rather than loop
   blindly or waive requirements.
3. Before landing, have the implementor rebase onto the current run branch in
   its own worktree and rerun required checks if the base advanced. Conflicts
   and substantive changes require renewed review; a clean rebase with no
   substantive change can retain approval. Compare the reviewed and current
   changes, not just commit IDs; if uncertain, review again. Repository rules
   for fetching and rewriting published branches still apply.
4. Verify the ticket worktree and integration worktree are clean, the reported
   head is still the ticket head, checks cover that head, blocking findings are
   resolved, and the current run head is its ancestor. Then, from the integration
   worktree on the recorded run branch, run `git merge --ff-only <ticket-head>`.
   Use the verified commit, not a moving branch name. Never force, reset, squash,
   or create a merge commit to make landing succeed.
5. If the run branch advanced or the merge fails, inspect why and return the
   ticket for rebase/checks/review as needed. Never mark a failed merge landed.
   After success, verify ancestry and record the landed commit before scheduling
   dependents. Close idle ticket workers that will receive no further prompts
   and remove clean ticket worktrees through project tooling without force.
   Respect Herdr's ownership rules when closing inherited panes. Retain branches
   and results; report cleanup failures without undoing landing.

## Supervise and adapt

Use Herdr's bounded waits and status inspection. Inspect every active ticket at
least every ten minutes, and report any with no new output since the last check.
An idle/done state, timeout, or completion marker is not proof the assignment
succeeded. Match the result to the assigned ticket and current Git state.
Inspect before retrying an ambiguous launch or prompt; do not create duplicate
workers. Use no custom daemon, stall classifier, or shell sleep loop.

Answer worker questions from the agreed spec and decisions when possible;
otherwise ask the user. Return failed checks to the implementor for fixes;
never skip them to reach review or landing. Scope changes, conflicting requirements, uncertain
recovery, and permissions need a decision, not an invented answer. Park only
the affected ticket and keep independent work moving. When parking it, ensure
its worker is stopped or waiting, not continuing uncounted work.

Persist preference changes before acknowledging them. New defaults govern
future launches, not existing workers. **Always ask once before migrating any
affected workers** to a different harness/model/effort, even after quota failure
or coordinator takeover. Preserve their worktrees and changes, verify old
workers are stopped, and record the approved replacement before launching it.
A reduced cap drains existing work rather than terminating it.

If the spec or ticket dependencies change, pause affected work, agree the scope
and review impact with the user, and record the decision. Other runs own their
own integration branches. Never silently share one or edit another run's state.

## Resume

Read [resume.md](references/resume.md) and reconcile the record with Git and
Herdr before acting. A Pi coordinator may resume a dead Claude coordinator's
run, or vice versa, without launching the old harness or reading its chat.
Verify that no previous coordinator is still driving the run. Reuse living
workers and their actual configuration; never equate a dead coordinator with
dead workers. Ask about gaps instead of fabricating state or relaunching work.

For an old Engine-era run, use
[legacy-migration.md](references/legacy-migration.md) first. Do not require its
old scripts or schema to keep running, and do not overwrite its evidence.

## Finish

When every ticket has landed, run the final repository checks on the integrated
branch and record their results. If they fail, delegate a bounded integration
fix, review it, and land it through the same process before repeating the checks.
Write `SUMMARY.md` with the run branch/head, delivered work, verification,
remaining low-severity suggestions, and retained artifacts. Blocked or
user-abandoned work must be reported explicitly, never as full completion.

Report the verified local run branch and **offer** trunk integration as a
separate action. Do not merge trunk, push, open a PR, or write to trackers
without the applicable explicit authorization. Keep the integration worktree
and run folder available for that decision.
