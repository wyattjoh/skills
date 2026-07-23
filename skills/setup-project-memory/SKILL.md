---
name: setup-project-memory
description: Captures a durable learning from the current session into an in-repo project memory. Creates a .claude/memory/ note, indexes it in MEMORY.md, imports that index into CLAUDE.md via @.claude/memory/MEMORY.md, then commits. Run with /setup-project-memory after solving something worth remembering.
allowed-tools:
  - Write
  - Edit
  - Read
  - Grep
  - Glob
  - AskUserQuestion
  - Bash(mkdir:*)
  - Bash(git status:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
disable-model-invocation: true
effort: medium
---

# Set Up Project Memory

Capture a durable, hard-won learning from the current session as an in-repo
memory note, so future sessions in this project pick it up automatically.

The note lives under `.claude/memory/`, a one-line summary goes into
`.claude/memory/MEMORY.md`, and that index is imported into the project's
`CLAUDE.md` with `@.claude/memory/MEMORY.md` (Claude Code loads imported files
into context each session). The skill takes no arguments: it infers the note
from the conversation, then commits after you confirm.

## End state

```
.claude/memory/
├── MEMORY.md          # index, imported by CLAUDE.md
└── <topic-slug>.md    # one plain-markdown note per learning
```

In `CLAUDE.md`:

```markdown
## Project memory

Durable, hard-won learnings and gotchas are indexed here. Read the linked note
when its topic comes up.

@.claude/memory/MEMORY.md
```

## Workflow

### 1. Preconditions

- Confirm a git repo: `git rev-parse --git-dir`. If it fails, stop and offer
  `git init` (the skill commits, so a repo is required).
- Locate the project root `CLAUDE.md`. If none exists, you will create one in
  step 3.

### 2. Decide what to capture (inferred, no arguments)

From the current conversation, distill the ONE reusable thing worth keeping:

- A short **kebab-case slug** for the filename (e.g. `firmware-workspace-sdkconfig`).
- A human **H1 title**.
- The **content**: what was non-obvious. Prefer symptom, root cause, the fix,
  and how to verify it.

Only capture durable knowledge (a gotcha, a decision, a hard-won fix). Do not
record transient task state, one-off progress, or anything the repo already
documents in code or git history.

### 3. Ensure the scaffolding exists (idempotent)

- `mkdir -p .claude/memory`.
- If `.claude/memory/MEMORY.md` is absent, create it (see format below).
- Ensure `CLAUDE.md` imports the index: it must contain the exact line
  `@.claude/memory/MEMORY.md`. If absent, append a `## Project memory` section
  (see wiring below). If `CLAUDE.md` itself does not exist, create it with that
  section as its only content.

Never duplicate the import or the section if they already exist.

### 4. Write the note

Write `.claude/memory/<slug>.md` as plain markdown (no frontmatter). See the
note format below. If the slug already exists, update that note instead of
creating a near-duplicate.

### 5. Update the index

Append one entry to `.claude/memory/MEMORY.md` linking the note. Keep entries
sorted by title and deduplicated (one per file).

### 6. Confirm, then commit

Show a plan: the note path, its one-line summary, the index entry, any
`CLAUDE.md` change, and the proposed commit message. Let the user approve or
request edits. Then commit (do not push):

```bash
git add .claude/memory/<slug>.md .claude/memory/MEMORY.md CLAUDE.md
git commit -m "docs: record <topic> in project memory"
```

Use a Conventional Commit subject. If the scaffolding or `CLAUDE.md` import was
created for the first time, say so in the plan.

## Note format

Plain markdown, one learning per file. Adapt sections to the learning; this is a
sensible default, not a rigid template:

```markdown
# <Title>

## Symptom / context

What you observed, or when this applies.

## Root cause

Why it happens (the non-obvious part).

## Fix

The concrete change, with the exact snippet or command.

## How to verify

A check that confirms the fix without guesswork.
```

## MEMORY.md format

```markdown
# Project memory

Index of durable learnings for this project. Read the linked file when its topic
is relevant.

- [<Title>](<slug>.md): one-line summary of the learning.
```

Links are relative to `.claude/memory/` (the index lives alongside the notes).

## CLAUDE.md wiring

The import path is relative to the file that contains it, so with `CLAUDE.md` at
the repo root the line is exactly:

```
@.claude/memory/MEMORY.md
```

Add it inside a short `## Project memory` section, placed near the end of
`CLAUDE.md`. If the project uses `AGENTS.md` instead of `CLAUDE.md`, add the
section there.

## Conventions

- Notes are durable learnings only (gotchas, decisions, hard-won fixes), never
  task logs or progress notes.
- Plain markdown, kebab-case filenames, one learning per file.
- No em dashes anywhere (use commas, colons, parentheses, or separate
  sentences).
- Keep each note focused and self-contained.

## Edge cases

- **Not a git repo:** stop, offer `git init`.
- **No CLAUDE.md:** create it containing just the `## Project memory` section.
- **Import already present:** do not add a second `@.claude/memory/MEMORY.md`.
- **Slug collision:** update the existing note rather than duplicating it, and
  refresh its index summary if the meaning changed.
- **Nothing durable to capture:** if the session has no reusable learning, say
  so and stop rather than writing a low-value note.
