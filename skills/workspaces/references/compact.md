# Flow: compact (collapse the ADR trail into the minimal vision)

Consumes the workspace in order and rewrites `docs/adr/` down to the smallest
set of ADRs that still expresses the final designed vision, dropping the
historical switches accumulated during design. This flow rewrites decision
records and reconciles design docs, so it is confirmation-gated like `init`
and refuses to run against a dirty hub.

What it does **not** touch: `JOURNAL.md` (the true audit trail stays intact),
`plan/tasks.md` (live operational state), and `workspace.yaml` / `CLAUDE.md`
(the generated manifest views). Only ADRs are archived; every other edit is
in place, with git holding prior versions.

## 1. Read the workspace in order

```bash
bun $SKILL_DIR/scripts/workspace.ts compact inventory --json --workspace <hub>
```

The inventory compresses the ADR graph (each ADR's number, title, status, and
the ADR numbers it references) plus the journal's Deviation and Scope change
entries and the ordered context layers. Read it, then read the actual layer
documents in load order (constitution → spec → decisions → phasing → tasks →
conventions) and the ADR prose. The inventory is structure; the meaning is in
the documents. First run `manifest sync --check` and `audit`; compacting a
workspace that is already drifting bakes the drift into the new baseline.

## 2. Grill to resolve ambiguity

Before proposing anything, run a focused grilling pass (the `grilling` skill)
on everything the trail leaves unclear: which of two competing decisions is
actually in force, whether a journaled deviation was a true reversal or a
refinement, whether an ADR with no status is still live. Do not guess the
final vision; put the ambiguities to the user and let them settle each one.

## 3. Derive the minimal ADR set

One ADR per durable decision. A decision is durable when its final state is
still in force in the vision the user just confirmed.

- **Collapse** each superseded chain to its surviving decision, one ADR, not
  the proposed → accepted → superseded lineage.
- **Merge** multiple ADRs that together express one coherent decision into a
  single ADR.
- **Drop** decisions that were fully reversed or abandoned; they are not part
  of the vision.
- **Keep** the rationale for why the surviving choice won, including the
  alternatives considered and rejected, which is vision, not churn.
- **Drop** the temporal narrative ("we first did X, then switched to Y"). The
  switch story lives on in `JOURNAL.md`, not in the compacted ADRs.

Renumber the survivors into a clean sequential set (`0001-`, `0002-`, …) in
MADR format (the `domain-modeling` ADR format; status `accepted`). Renumbering
breaks references from member PRs and the intact journal, which is accepted;
the archive preserves the old numbers and the mapping manifest records the
translation.

## 4. Propose for review

Write a proposal to the session scratchpad and summarize it inline. Do not
write it into the hub. It must enumerate:

- The old → new ADR mapping, and every dropped ADR with the reason it is not
  part of the vision.
- The full text of each new minimal ADR.
- The per-document reconcile edits for `docs/spec/`, `docs/constitution.md`,
  and `plan/phases.md` (see step 5) and the `docs/index.md` housekeeping.
- Any contradiction between the compacted vision and a document the flow does
  not rewrite: surface it for the user to resolve (often a journal Decision),
  never silently mutate around it.

Get an explicit yes. Never skip this gate even when the skill was model-invoked.

## 5. Apply on a clean tree, in one commit

The hub work tree must be clean so the whole compaction is one reviewable,
revertible diff. Then:

1. **Archive the current ADRs.**

   ```bash
   bun $SKILL_DIR/scripts/workspace.ts compact archive --workspace <hub>
   ```

   This refuses on a dirty tree, `git mv`s every live `docs/adr/*.md` into
   `docs/adr/archive/`, and prints the archived mapping.

2. **Write the minimal set** into `docs/adr/` (the renumbered, `accepted`
   ADRs from the approved proposal).
3. **Write the mapping manifest** `docs/adr/archive/README.md`: which archived
   ADRs collapsed into which new number, and which were dropped and why. This
   is what keeps the collapse traceable without the journal.
4. **Reconcile and compact in place** `docs/spec/`, `docs/constitution.md`,
   and `plan/phases.md`: fix anything the new ADRs contradict and strip prose
   describing abandoned directions. Refresh `docs/index.md` so its Decisions
   annotation still resolves and notes that `archive/` is history, not context.
5. **Verify and commit.**

   ```bash
   bun $SKILL_DIR/scripts/workspace.ts audit --workspace <hub>   # must pass
   git -C <hub> add -A && git -C <hub> commit   # docs: compact workspace ADRs
   ```

If `audit` fails or the apply is wrong, the tree is dirty but uncommitted:
fix forward, or `git -C <hub> reset --hard && git -C <hub> clean -fd docs/adr`
to return to the pre-compaction baseline and start over. Never commit a
half-compacted hub.

## The archive is history, not context

`docs/adr/archive/` sits inside the `decisions` context layer (`docs/adr`), so
it must never be loaded as context; the `enter` flow reads only the top-level
`docs/adr/*.md` (the live minimal set). If archived ADRs get reloaded on every
`enter`, the compaction was cosmetic. `audit` warns
(`adr-archive-unmanifested`) when the archive lacks its README.md mapping.
