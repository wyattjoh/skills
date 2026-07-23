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

## Flows

Each flow is specified in `references/`; the SKILL.md routes to them.

| Flow      | Purpose                                                              |
| --------- | -------------------------------------------------------------------- |
| `init`    | Scaffold a new hub (confirmation-gated; seeds docs, skills, memory)  |
| `enter`   | Load context to start or resume work (memory first, then layers)     |
| `task`    | Create, update, redesign, execute, or drop a unit of work            |
| `audit`   | Run every integrity check and drive remediation                      |
| `compact` | Collapse the ADR trail into a minimal set capturing the final vision |

## CLI

All mechanics go through one Bun CLI; every hub's Justfile delegates to it:

```bash
bun $SKILL_DIR/scripts/workspace.ts <command> [--workspace <hub-dir>]
```

Commands: `manifest sync [--check]`, `manifest freeze`, `status`, `stacks`,
`context`, `audit`, `journal add`, `compact inventory`, `compact archive`.
Inside a hub, prefer the Justfile recipes (`just sync`, `just audit`,
`just journal …`, `just compact-inventory`, …).

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
