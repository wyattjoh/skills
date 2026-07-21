---
name: workspaces
description: Creates and operates multi-repo workspace hubs, standalone git repositories that own the docs, ADRs, deviation journal, context manifest, release phasing, plan batches, and project-local skills for a cross-repo body of work. Use when creating a workspace for a multi-repo effort, adding or redesigning a task inside one, entering a workspace to load its context, or checking workspace integrity. Triggers on "create a workspace", "new workspace", "workspace for", "enter the workspace", "load workspace context", "workspace task", "audit the workspace", or landing in a directory containing workspace.yaml.
argument-hint: "[init|task|enter|audit] [name]"
effort: high
---

# Workspaces

A workspace is a standalone git repository that acts as the documentation,
decision, and planning hub for work spanning multiple member repositories.
The hub owns everything about the work; member repos own only code. Agent
context is explicit (a manifest declares it), layered (loaded in a fixed
order), and auditable (generated views drift-checked by script).

This skill composes existing skills rather than replacing them:
`grill-with-docs` scopes, `domain-modeling` owns CONTEXT.md and ADRs,
`task-planner` emits plan batches (into the hub), `task-orchestrator`
executes them (in member repos), `stacked-prs` binds branches to the
workspace by naming, `worktrunk` materializes interactive worktrees, and
`claude-skills` standards govern the seeded project-local skills.

## Routing

Match the request to a flow and follow its reference document exactly:

| Flow    | When                                                      | Reference                                  |
| ------- | --------------------------------------------------------- | ------------------------------------------ |
| `init`  | Create a new workspace (confirmation-gated)               | [references/init.md](references/init.md)   |
| `task`  | Create, update, redesign, execute, or drop a unit of work | [references/task.md](references/task.md)   |
| `enter` | Load workspace context to start or resume work            | [references/enter.md](references/enter.md) |
| `audit` | Verify integrity, find drift, drive remediation           | [references/audit.md](references/audit.md) |

Before any flow, read
[references/workspace-layout.md](references/workspace-layout.md) for the hub
anatomy and [references/conventions.md](references/conventions.md) for the
binding rules. When creating or editing the seeded skills, follow the
`claude-skills` skill.

## Scripts

All workspace mechanics go through one CLI (the consistent binding point;
every workspace's Justfile delegates here):

```bash
bun $SKILL_DIR/scripts/workspace.ts <command> [--workspace <hub-dir>]
```

| Command                                                               | Purpose                                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `manifest sync [--check]`                                             | Regenerate CLAUDE.md from workspace.yaml (`--check` exits 1 on drift)                  |
| `manifest freeze`                                                     | Capture member HEAD SHAs into workspace.lock                                           |
| `status [--json]`                                                     | Per-member branch, dirtiness, and bound stacks                                         |
| `stacks [--json]`                                                     | All stacks across members matching the workspace stack prefix                          |
| `context [--json]`                                                    | Ordered context-layer files (fails if any are missing)                                 |
| `audit [--json]`                                                      | Every integrity check; exits 1 on errors                                               |
| `journal add --category <c> --title <t> [--links <csv>] [--body <b>]` | Append a structured journal entry (categories: decision, deviation, scope, cross-repo) |

`--workspace` defaults to walking up from the current directory to the
nearest `workspace.yaml`. Member state is read via `git -C` from the hub;
no command enters a worktree.

## Core rules (full detail in conventions.md)

1. **One creator per branch+worktree pair.** wt owns interactive worktrees,
   task-orchestrator owns batch worktrees, stacked-prs owns metadata only.
   Never run stacked-prs `create` for a child branch inside a wt worktree.
2. **Hub owns planning.** Plan files live in
   `plan/batches/<member>/<task-slug>/`; task-orchestrator is pointed at
   that directory from inside the member repo. Member repos never commit
   workflow artifacts.
3. **Binding is naming.** Stacks `<stack-prefix><task-slug>` (no dots),
   branches `<branch-prefix><task-slug>`, batch dirs on the same slug.
4. **Manifest is truth.** Edit `workspace.yaml`, run `just sync`; never
   hand-edit CLAUDE.md. `docs/index.md` is the context allow-list.
5. **Deviations are journaled** before or with the change, cross-linked to
   phase, ADR, and PR. ADRs are superseded, never edited.
6. **init is gated.** Always confirm with the user before creating the hub
   repo, touching member git config, or registering sources.

## Templates

`references/templates/` holds the scaffold for every hub file
(`workspace.yaml`, `JOURNAL.md`, `constitution.md`, `index.md`, `phases.md`,
`tasks.md`, `Justfile`) and the three seed skills
(`skill-context.md`, `skill-domain.md`, `skill-conventions.md`).
Markdown and YAML templates use `{{PLACEHOLDER}}` markers; the Justfile
template alone uses `__PLACEHOLDER__` markers because just owns `{{ }}`
interpolation there (and markdown formatters rewrite `__x__` as bold).
