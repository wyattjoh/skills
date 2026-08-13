# Flow: task — create, update, or redesign a unit of work

Everything that changes WHAT the workspace is building goes through this
flow. It keeps the hub's records ahead of the member repos' code.

## Create a task

1. **Scope it.** Read the workspace memory first (`.claude/memory/`), then
   run a focused grilling pass (the `grilling` skill) against the existing
   workspace docs — constitution, specs, and active ADRs are the baseline,
   so only grill the delta. **Capture as you go:** every idea, alternative,
   rejection-with-reason, and open question that surfaces during scoping
   becomes a memory entry at the moment it surfaces — design work converges
   on recorded concepts; it does not fan out into unrecorded variant
   floods. Write or update `docs/spec/<topic>.md`. If a direction-setting
   choice emerged, record an ADR (domain-modeling) now and point the
   related memory entries at it.
2. **Register it.** Add a row to `plan/tasks.md`: task slug, phase, members
   touched, batch paths, stack names (`<stack-prefix><task-slug>`), and
   cross-member dependencies. If the task does not fit an existing phase,
   that is a phasing change — update `plan/phases.md` and journal it.
3. **Plan per member.** For each member the task touches, write the member's
   implementation plan under the hub and record any cross-member ordering in
   `plan/tasks.md`.
4. **Create the stack.** In each member repo, create the stack via the
   stacked-prs skill with `--stack-name <stack-prefix><task-slug>` and
   branches named `<branch-prefix><task-slug>-<step>`. Respect worktree
   ownership (see conventions.md): register branches with stacked-prs, then
   materialize them with `wt switch`.
5. **Journal it.** `just journal decision "Task <slug> planned" "phase N, adr/NNNN"`.

## Execute a task

1. From inside each member repo, implement the plan on the bound branch or
   worktree, following the stack order recorded in `plan/tasks.md`.

2. Run members in the order recorded in `plan/tasks.md` (cross-member
   dependencies are sequenced here).
3. Brief every executing agent (subagent, orchestrator task, or fresh
   session) with the memory entries touching its work, and fold what
   execution teaches — surprises, tooling gotchas, decisions-in-motion —
   back into memory as it happens, not at the end.
4. When a phase's exit criteria are all met, check them off in
   `plan/phases.md`, advance the phase status, and journal the transition.

## Update or redesign a task

Redesign is a first-class path, not an exception:

1. Re-grill the changed aspect against the current docs, starting from the
   memory entries that touch it (they carry the rejected paths and open
   questions the docs may not); capture what the re-grill surfaces the same
   way scoping does.
2. Supersede affected ADRs (new ADR with a forward link; never edit the old
   one) and update the spec.
3. Update the task row (and phases if scope moved) in the hub.
4. Journal the deviation or scope change **before or with** the code change,
   linking plan/phase, ADR, and member PR.
5. Update the affected implementation plans and validate their dependencies.

## Dropping a task

Mark the row `dropped` in `plan/tasks.md`, journal a scope change with the
reason, and archive the stack (stacked-prs archive) rather than deleting
branches with history worth keeping.
