---
name: coordinate-implementation
description: Coordinates local spec and ticket implementation through Pi or Claude Code workers in Herdr, with parallel implementation, per-ticket review, and serial integration onto a dedicated run branch. Use for "/coordinate-implementation", "implement the tickets in", "orchestrate the run", or "resume the implementation run".
argument-hint: "[.scratch/<slug> | resume .scratch/<slug>]"
compatibility: Requires Git, a Herdr-managed pane, the herdr skill, and the chosen worker harnesses (Pi or Claude Code).
disable-model-invocation: true
user-invocable: true
---

# Coordinate implementation

Coordinate the spec and tickets in `$ARGUMENTS`, a local run folder or `resume <folder>`.
You delegate implementation and review; you own scheduling, decisions, and integration.
Use the `herdr` skill for worker sessions and the repository's conventions for development.

## Agree on the run

Read the local spec and tickets. Agree on a dedicated integration branch and worktree,
ticket worktree location, implementor/reviewer harness-model-effort defaults, and an
in-flight cap. Ask for missing preferences together; approval covers routine ticket setup
within those bounds. Use a Git-ignored run folder shared by the workers.

Communicate through short briefs and pointers to the spec, tickets, and decisions.
Keep a concise `RESUME.md` with the current state, worker identities, evidence, and next
actions, following [resume.md](references/resume.md). You own this shared record.

## Keep work moving

Tickets form a dependency graph. Run ready tickets in parallel, each in its own branch,
worktree, and Herdr tab. Dependencies become satisfied when their work lands, not when a
worker says it is done. The cap counts tickets through implementation, review, fixes, and
landing. Blocked tickets release capacity while their workers wait; resuming needs a slot.

Implementors own their code, commits, repository checks, and rebase conflicts. Give each
ticket one fresh, read-only reviewer covering both Standards and Spec, including check
evidence. Send medium-or-higher findings back to the implementor and review the fixes;
low-severity suggestions do not block landing. Avoid additional nested reviews.

Implementation and review stay parallel. **Only you land tickets, serially**, using
`git merge --ff-only` onto the run branch. The implementor rebases onto its current head
and reruns checks when it advances. Repeat review for conflicts or substantive changes,
or when uncertain; otherwise retain approval. Land only the checked, approved result.
After landing, safely clean up the ticket's idle sessions and clean worktree, retaining
its branch and results.

Supervise with bounded Herdr waits, checking every active ticket at least every ten minutes.
Inspect ambiguous failures before retrying; recover clear mechanical problems and ask
about scope, permissions, or uncertainty. Keep independent work moving around blockers.
An idle session, failed check, or empty frontier is not successful completion.

Record preference changes before acknowledging them. Defaults affect future launches;
a lower cap drains existing work. **Always ask once before migrating affected workers**
to another harness, model, or effort. Never silently substitute a configuration.

## Resume and finish

Either Pi or Claude can resume a dead coordinator's run without its harness or chat history.
Reconcile `RESUME.md` with Git and live workers before continuing, without duplicating work.
For Engine-era runs, follow [legacy migration](references/legacy-migration.md).
There is no detached runtime: coordination after exit requires an explicit resume.

Finish with a verified local run branch and `SUMMARY.md`; delegate any integration fixes
through the same review and landing process. Report blocked or abandoned scope honestly.
Offer trunk integration separately. Do not merge trunk or perform remote writes without
explicit authorization permitted by repository policy.
