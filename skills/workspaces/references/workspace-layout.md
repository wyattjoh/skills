# Workspace hub layout

The canonical structure `init` creates. The hub is its own git repository,
placed as a sibling of the primary member repo
(`~/Code/github.com/<org>/<name>-workspace/`). It is a developer workflow
tool: member repositories are referenced, never vendored, and never carry
committed workspace artifacts.

```
<name>-workspace/
├── workspace.yaml        # SOURCE OF TRUTH (schema below)
├── workspace.lock        # optional frozen member SHAs (just freeze)
├── CLAUDE.md             # GENERATED from workspace.yaml by `just sync`
├── AGENTS.md             # symlink -> CLAUDE.md
├── CONTEXT.md            # glossary / ubiquitous language (domain-modeling)
├── JOURNAL.md            # deviation-driven changelog (see format below)
├── Justfile              # thin recipes delegating to the skill scripts
├── docs/
│   ├── index.md          # curated, annotated context index (the allow-list)
│   ├── constitution.md   # invariant principles
│   ├── spec/             # WHAT/WHY documents from scoping sessions
│   ├── research/         # research reports (they outlive their sessions)
│   └── adr/              # NNNN-slug.md decision records (domain-modeling)
│       └── archive/      # ADRs retired by `compact` + README.md mapping (history, not context)
├── plan/
│   ├── phases.md         # release phases with measurable exit criteria
│   ├── tasks.md          # task registry: task -> members, batches, stacks
│   └── batches/
│       └── <member>/
│           └── <task-slug>/
│               └── NN-slug.md   # task-planner output, task-orchestrator input
├── .claude/
│   ├── memory/
│   │   ├── MEMORY.md     # memory index: one line per entry (seeded at init)
│   │   └── <slug>.md     # one memory entry per file, COMMITTED
│   └── skills/           # relative symlinks to skills/ (project-local)
└── skills/
    ├── <slug>-context/SKILL.md      # context loader (seeded at init)
    ├── <slug>-domain/SKILL.md       # domain model summary (seeded at init)
    └── <slug>-conventions/SKILL.md  # binding conventions (seeded at init)
```

## workspace.yaml schema

Validated by `scripts/lib/manifest.ts`; violations are all reported at once.

| Key                         | Required       | Meaning                                                                  |
| --------------------------- | -------------- | ------------------------------------------------------------------------ |
| `version`                   | yes            | Must be `1`                                                              |
| `name`                      | yes            | Human name of the body of work                                           |
| `slug`                      | yes            | Kebab-case identifier; default prefix source                             |
| `description`               | yes            | One-paragraph statement of the work                                      |
| `members[]`                 | yes, non-empty | `name`, `path` (relative to hub), optional `url`, `ref` (default `main`) |
| `context.layers[]`          | yes, non-empty | Ordered `name`/`path`/`description`; the `enter` load order              |
| `skills[]`                  | no             | Project-local skill names under `skills/`                                |
| `conventions.stack-prefix`  | no             | Default `<slug>/`; must not contain dots                                 |
| `conventions.branch-prefix` | no             | Default `<slug>/`; set `<user>/<slug>/` to match personal branch rules   |

## Generated files

`CLAUDE.md` is rendered deterministically from the manifest
(`scripts/lib/generate.ts`). Hand edits are overwritten by `just sync` and
flagged by `audit` — this is what makes agent context auditable by diff.
`AGENTS.md` stays a symlink so Claude and Codex read identical context.
The generated file includes a "Workspace memory" section pointing every
session at `.claude/memory/MEMORY.md` before any work — so the memory
mandate reaches even sessions that never invoke this skill. After upgrading
the skill, run `just sync` in each hub so its CLAUDE.md picks the section
up (audit reports `claude-md-stale` until then).

## workspace.lock

`just freeze` captures each member's HEAD SHA. The lock is optional and
informational: `audit` warns (never errors) when a member HEAD differs from
its frozen SHA, which makes "the state this decision was made against"
reconstructible.

## JOURNAL.md format

Newest date first. Sections `## YYYY-MM-DD`, entries
`### <Category>: <title>` with categories `Decision`, `Deviation`,
`Scope change`, `Cross-repo change`, an optional `**Links:**` line
(plan/phase, ADR, member PR), and an optional body. Append only via
`just journal` / `workspace.ts journal add` so the structure stays parseable.

## Workspace memory

`.claude/memory/` is the hub's committed working-knowledge layer — the
compressed "what you must know before touching this effort" that survives
context windows, sessions, and machines. It complements the durable records
rather than duplicating them: ADRs hold decisions, the journal holds
deviations, findings hold cited discoveries; memory holds the hot digest of
all three plus the in-flight material none of them accept yet — ideas and
alternatives still forming, rejected options worth not re-proposing, open
questions, tooling gotchas, and pointers into the records.

- One entry per file: `.claude/memory/<kebab-slug>.md`. Shape: a `#` title,
  a few sentences stating the fact or idea, a `**Why it matters:**` line,
  and a `**See:**` line linking the ADR/journal/spec/ticket it relates to.
- `MEMORY.md` is the index: one line per entry,
  `- [Title](<file>.md) — hook`. Every entry is listed; an unindexed entry
  is invisible and `audit` flags it.
- Lifecycle: an entry is written the moment the knowledge surfaces (not at
  session end); when it settles into an ADR, journal entry, or finding, the
  entry is rewritten to point at that record — or deleted if the record
  fully covers it. Wrong memories are deleted, not annotated.
- Memory lives only in the hub — never in member repos (purity rule) and
  never in a harness's private state, so any agent, harness, or human gets
  the same recall.

## Plan batches

`task-planner` runs with `--out plan/batches/<member>/<task-slug>/` so plan
files live in the hub. `task-orchestrator` is invoked from inside the member
repo and pointed at that hub directory (its plans-dir argument accepts any
path). Plan-file dependencies (`depends-on`) only work within one batch;
cross-member ordering lives in `plan/tasks.md`.
