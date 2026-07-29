# workspaces

Create and operate **workspace hubs**: standalone git repositories that own
the documentation, decisions, planning, memory, and agent context for a body
of work spanning multiple member repositories. The hub owns everything about
the work; member repos own only code.

The skill exists because cross-repo efforts rot in predictable ways: context
lives in one contributor's head, decisions are re-litigated because nobody
recorded the rejection, plans drift from code with no audit trail, and every
fresh agent session relearns the effort from scratch. A hub makes all of
that explicit, layered, and checkable by script.

## What a hub gives you

- **Explicit agent context** — `workspace.yaml` declares ordered context
  layers (constitution → spec → ADRs → phasing → tasks → conventions);
  `CLAUDE.md` is _generated_ from it, so context changes are auditable by
  diff. `AGENTS.md` is a symlink, so Claude and Codex read the same thing.
- **Decision discipline** — ADRs are superseded, never edited; deviations
  are journaled before or with the change; the `compact` flow collapses a
  long ADR trail into a minimal live set with an archive mapping.
- **Workspace memory** — `.claude/memory/` is the committed
  working-knowledge layer: one fact per file, indexed by `MEMORY.md`, read
  before any flow and written the moment an idea, rejection, surprise, or
  open question surfaces. Settled entries graduate to an ADR, journal
  entry, or finding and become pointers. The generated CLAUDE.md points
  every session at the index, so the mandate reaches sessions that never
  invoke this skill, and `audit` enforces the structure
  (`memory-missing`, `memory-unindexed`).
- **Cross-repo binding by naming** — one task slug names the registry row,
  the plan batch, the stack, and the branches, so hub-to-code traceability
  is inspection, not archaeology.
- **Member repo purity** — member repositories never commit workflow
  artifacts; `audit` flags violations.

## Commands: two layers

The skill's subcommands live at two levels. Understanding the split is worth
the paragraph, because they do different jobs:

- **Flows** are the conversational entry points — high-level intents you route
  to ("enter the workspace", "add a task"). Each flow follows a reference doc
  exactly, interpreting results and driving the work.
- **CLI commands** are the deterministic mechanics each flow delegates to, all
  through one Bun script. Every hub's Justfile wraps them as `just <recipe>`.

`audit` and `compact` appear in **both** layers: the flow is the human-facing
procedure (interpret output, drive remediation), while the CLI command is the
raw mechanical check it runs.

### Flows

Each flow is specified in `references/`; the SKILL.md routes to them.

| Flow      | When to use                                     | What it does                                                                                                                                                                                                 |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`    | Creating a brand-new hub                        | Scaffolds the standalone hub repo (workspace.yaml, constitution, ADRs, phases, tasks, seed skills, memory). Confirmation-gated before creating the repo, touching member git config, or registering sources. |
| `task`    | Create, update, redesign, execute, or drop work | Manages a task's whole lifecycle: emits plan batches into `plan/batches/<member>/<task-slug>/`, binds branches/stacks by naming, orchestrates execution in member repos.                                     |
| `enter`   | Starting or resuming work                       | The "get me oriented" flow. Reads workspace memory first, then loads the context layers in fixed order (constitution → spec → ADRs → phasing → tasks → conventions → findings).                              |
| `audit`   | Verifying integrity                             | Runs every drift check, finds inconsistencies between the manifest and reality, and drives remediation.                                                                                                      |
| `compact` | Collapsing the ADR trail                        | Archives the live ADRs into a minimal set capturing the _final_ vision (not the full superseded history), with an archive mapping.                                                                           |

### CLI commands

All mechanics go through one Bun CLI; every hub's Justfile delegates to it:

```bash
bun $SKILL_DIR/scripts/workspace.ts <command> [--workspace <hub-dir>]
```

`--workspace` defaults to walking up to the nearest `workspace.yaml`. Inside a
hub, prefer the Justfile recipes.

| Command                                                     | Purpose                                                                                           | Justfile recipe          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `manifest sync [--check]`                                   | Regenerate CLAUDE.md from workspace.yaml (`--check` exits 1 on drift). Never hand-edit CLAUDE.md. | `just sync`              |
| `manifest freeze`                                           | Capture member HEAD SHAs into workspace.lock                                                      | `just freeze`            |
| `status [--json]`                                           | Per-member branch, dirtiness, and bound stacks                                                    | `just status`            |
| `stacks [--json]`                                           | All stacks across members matching the workspace stack prefix                                     | `just stacks`            |
| `context [--json]`                                          | Ordered context-layer files (fails if any are missing)                                            | `just context`           |
| `audit [--json]`                                            | Every integrity check; exits 1 on errors                                                          | `just audit`             |
| `journal add --category <c> --title <t> [--links] [--body]` | Append a structured journal entry (categories: decision, deviation, scope, cross-repo)            | `just journal <c> <t>`   |
| `compact inventory [--json]`                                | List live ADRs, journal switches, and context layers                                              | `just compact-inventory` |
| `compact archive [--json]`                                  | Move live ADRs into `docs/adr/archive/` (clean tree required); print the mapping                  | `just compact-archive`   |

## Hub anatomy (abridged)

```
<name>-workspace/
├── workspace.yaml        # source of truth; CLAUDE.md is generated from it
├── CLAUDE.md / AGENTS.md # generated context + symlink
├── CONTEXT.md            # glossary / ubiquitous language
├── JOURNAL.md            # deviation-driven changelog
├── docs/                 # index.md (allow-list), constitution, spec/, adr/ (+ archive/)
├── plan/                 # phases.md, tasks.md, batches/<member>/<task-slug>/
├── .claude/memory/       # MEMORY.md index + one committed entry per file
└── skills/               # seeded project-local skills (context/domain/conventions)
```

Full detail: `references/workspace-layout.md`. Binding rules:
`references/conventions.md`.

## Composes with

`grill-with-docs` (scoping), `domain-modeling` (CONTEXT.md + ADRs),
`task-planner` (plan batches), `task-orchestrator` (batch execution),
`stacked-prs` (stack naming/metadata), `worktrunk` (interactive worktrees),
`claude-skills` (seeded-skill standards).

## Development

```bash
cd skills/workspaces
bun test          # scripts/lib/*.test.ts
```

Scripts are Bun + TypeScript with Effect for I/O-bearing logic, per this
repo's `.claude/rules/skills.md`. The audit checks live in
`scripts/lib/audit.ts`; CLAUDE.md rendering in `scripts/lib/generate.ts`
(deterministic — staleness is detected by full-content comparison).
