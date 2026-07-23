# Flow: enter — load workspace context

Run this when landing in a workspace hub, in any member repository of a
workspace, or when asked to pick up work that a workspace owns. The goal is
that every layer of context an agent needs is loaded explicitly and in
order, and that stale context is detected before it misleads.

## 1. Locate the workspace

From a hub or below it, the scripts find the root themselves (they walk up
to `workspace.yaml`). From a member repo, find the hub via the member's
sibling directories or ask the user; the member's `<slug>-context` skill
(if linked) already names the hub path.

## 2. Verify before loading

```bash
bun $SKILL_DIR/scripts/workspace.ts manifest sync --check --workspace <hub>
bun $SKILL_DIR/scripts/workspace.ts context --workspace <hub>
```

If either fails, the context is not trustworthy: run the audit flow first
and fix drift before reading further. Loading stale context silently is how
workspaces rot.

## 3. Load workspace memory first

Read `.claude/memory/MEMORY.md`, then every indexed entry whose hook touches
the work at hand. Memory is the digest layer: it tells you which parts of
the fuller context deserve attention, which ideas were already rejected, and
which gotchas are live. If the directory is missing, seed it from
`$SKILL_DIR/references/templates/memory-index.md` before continuing — a hub
without memory forces every session to relearn the effort from scratch.

## 4. Load the layers in order

Read each file `context` printed, top to bottom (constitution -> spec ->
decisions -> phasing -> tasks -> conventions). Order matters: later layers
narrow earlier ones. For the ADR layer, read the top-level `docs/adr/*.md`
(the live set): read `accepted` ADRs, skim `superseded` only when tracing why
something changed. Never load `docs/adr/archive/`; that is compacted history
(see the compact flow), not context; open it only when tracing what a past
compaction dropped.

## 5. Load the working state

```bash
bun $SKILL_DIR/scripts/workspace.ts status --workspace <hub>
bun $SKILL_DIR/scripts/workspace.ts stacks --workspace <hub>
```

Then skim the newest `JOURNAL.md` sections — the journal records what
changed more recently than the documents.

## 6. Report

Summarize for the user: active phase and its unmet exit criteria, in-flight
tasks and their stacks, any drift or missing members, what the journal says
happened last, and anything in memory that changes how the next work should
run (live gotchas, open questions, rejected paths). End with where work can
resume. If loading revealed knowledge memory lacks — or memory that is now
wrong — write or delete the entries before starting the work.
