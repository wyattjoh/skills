---
name: task-planner
description: >-
  Decomposes a settled feature design into a validated set of task-orchestrator
  plan files through a one-at-a-time grilling pass on task seams, dependencies,
  and acceptance criteria. Use after grill-with-docs or whenever a large feature
  needs breaking into independently-buildable tasks. Triggers on "break this
  into tasks", "plan this feature", "decompose this into plans", "make plans for
  the orchestrator".
argument-hint: "[design-doc path or feature description] [--out <dir>]"
effort: high
---

# Task Planner

Turn a settled feature design into a validated directory of
`task-orchestrator` plan files. This skill owns decomposition only:
`grill-with-docs` settles the design, `task-planner` creates the task graph, and
`task-orchestrator` executes the resulting plans.

Do not use this as a design tool. If the available context is too thin to
identify concrete seams, dependencies, and acceptance criteria, say so and
suggest running `grill-with-docs` first.

## Quick Start

1. **Source the design.** Use the conversation, a design doc path, ADRs, or a
   glossary from `grill-with-docs`. If the design is unsettled, stop and
   recommend `grill-with-docs`.
2. **Draft the decomposition.** Propose an initial task list and DAG. Each task
   should be one focused review loop, not a mini-project.
3. **Grill one question at a time.** Use
   [references/decomposition-grilling.md](references/decomposition-grilling.md)
   across seams, dependency edges, conflict hotspots, acceptance criteria, and
   risk.
4. **Maintain JSON.** Keep the working decomposition as an array of:
   ```json
   [
     {
       "id": "01-schema",
       "title": "Schema migration",
       "dependsOn": [],
       "context": "Why this task exists and the design source it traces to.",
       "implementation": "Scope, boundaries, and likely files touched.",
       "acceptance": ["Concrete reviewer-checkable condition"]
     }
   ]
   ```
5. **Validate before writing.** Save the JSON to a temp file, then invoke the
   `task-orchestrator` skill to validate the decomposition JSON at that path.
   A validation failure means the graph is invalid. Fix cycles, dangling refs,
   or duplicate ids before writing plan files.
6. **Emit plans.** Default to `plans/<feature-slug>/`, unless `--out <dir>` was
   provided:
   ```bash
   bun $SKILL_DIR/scripts/scaffold.ts <decomposition.json> --out plans/<feature-slug>
   ```
7. **Final validate.** Invoke the `task-orchestrator` skill to validate the
   plan directory at `plans/<feature-slug>` and display the graph.
8. **Offer execution.** Summarize the plan set and DAG, then ask whether to stop
   for review or run `task-orchestrator` on the emitted directory now. Frame
   review as the default, while keeping orchestration one explicit approval away.

## Plan Files

`scaffold.ts` emits one file per task. The filename is exactly `<id>.md`, so ids
must already be in `NN-slug` form. `task-orchestrator` uses the filename stem as
the task id, and `depends-on` entries must reference those stems exactly.

Each emitted file follows this template:

```markdown
---
title: API endpoints for billing
depends-on: [01-schema]
---

# API endpoints for billing

## Context

Why this task exists; links to the relevant ADR/glossary term from grill-with-docs.

## Implementation

The work, explicit scope boundaries (in/out), and the files likely touched.

## Acceptance criteria

- Concrete, checkable conditions the reviewer verifies
```

`## Acceptance criteria` is load-bearing. It is the reviewer checklist for the
orchestrator loop, so every task needs at least one concrete, checkable item.

## Scripts

Scaffold plan files from a decomposition JSON array:

```bash
bun $SKILL_DIR/scripts/scaffold.ts <decomposition.json> --out <plans-dir> [--pretty]
```

The script validates task shape, enforces `NN-slug` ids, removes stale Markdown
files in the output directory, writes deterministic plan files, and prints the
written file list as JSON.
