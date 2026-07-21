---
name: {{WS_SLUG}}-conventions
description: Binding, naming, and workflow conventions for the {{WS_NAME}} workspace. Use when creating branches, stacks, worktrees, or PRs in any {{WS_NAME}} member repository, or when recording decisions and deviations for this work.
---

# {{WS_NAME}} conventions

Workflow conventions binding the {{WS_NAME}} workspace
(`{{WS_PATH}}`) to its member repositories. These exist so every artifact is
attributable to the workspace and auditable from the hub.

## Naming and binding

- Stack names: `{{STACK_PREFIX}}<task-slug>` (created via the stacked-prs
  skill with `--stack-name`). Never use dots in a stack name.
- Branch names: `{{BRANCH_PREFIX}}<task-slug>`.
- Plan batches: `{{WS_PATH}}/plan/batches/<member>/<task-slug>/`.
- The hub reads stack state without entering worktrees by invoking the
  `workspaces` skill to list stacks for `{{WS_PATH}}`.

## Worktree ownership (one creator per branch+worktree)

- `wt` (worktrunk) creates interactive/feature worktrees.
- `task-orchestrator` creates its own batch worktrees for orchestrated runs.
- stacked-prs manages stack metadata only; never use its worktree-creating
  options here, and never run `stacked-prs create` for a child branch from
  inside a wt-managed worktree (it moves that worktree's HEAD).

## Member repository purity

Member repos never gain committed workflow artifacts. Runtime residue is
limited to local-excluded paths (`.claude/worktrees/`,
`.claude/task-orchestrator/`) and git config (stack metadata). Anything else
is drift; the workspace `audit` flow flags it.

## Recording changes

- Direction-setting choices: ADR (docs/adr/ in the hub) plus
  `just journal decision`.
- Divergence from a recorded plan/spec/ADR: `just journal deviation` before
  or with the change.
- Scope moves and coordinated cross-member changes: `just journal scope` /
  `just journal cross-repo`.
