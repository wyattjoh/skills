# Flow: audit — verify workspace integrity

Runs every integrity check and drives remediation. The check engine is
`scripts/lib/audit.ts`; this document maps findings to fixes.

```bash
bun $SKILL_DIR/scripts/workspace.ts audit --workspace <hub>   # or: just audit
```

Errors exit 1; warnings report and exit 0. Fix errors immediately; treat
recurring warnings as decisions to make (fix the cause or change the
manifest) rather than noise to ignore.

## Findings and remediation

| Finding                                    | Level | Meaning and fix                                                                                                                                                                                                                               |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-md-missing` / `claude-md-stale`    | error | Generated context diverged from `workspace.yaml`. Run `just sync`. If someone hand-edited CLAUDE.md, move the edit into the manifest or a layer doc first — the hand edit is about to be overwritten.                                         |
| `agents-md-missing` / `agents-md-not-link` | error | `AGENTS.md` must be a symlink to `CLAUDE.md` (`ln -sfn CLAUDE.md AGENTS.md`) so Claude and Codex read identical context.                                                                                                                      |
| `layer-missing`                            | error | A manifest context layer points at a missing path. Restore the file or remove/correct the layer (a manifest edit + `just sync` + journal entry).                                                                                              |
| `layer-unindexed`                          | warn  | A layer is not referenced by `docs/index.md`. Add an annotated entry; unindexed context is invisible context.                                                                                                                                 |
| `index-missing`                            | warn  | `docs/index.md` is gone. Reseed from `$SKILL_DIR/references/templates/index.md` and re-annotate.                                                                                                                                              |
| `journal-missing`                          | error | `JOURNAL.md` is required. Reseed from the template; if history was lost, journal that loss as a deviation.                                                                                                                                    |
| `member-missing` / `member-not-git`        | error | A member path is absent or not a repo. Clone it, fix `members[].path`, or remove the member (manifest edit + journal scope change).                                                                                                           |
| `member-workflow-artifacts`                | warn  | A member repo tracks files under `.claude/worktrees/` or `.claude/task-orchestrator/`. Untrack them (`git rm --cached`) in that repo and ensure its local exclude covers the paths — member repos must carry no committed workflow artifacts. |
| `lock-unknown-member` / `lock-stale`       | warn  | `workspace.lock` disagrees with the manifest or member HEADs. Run `just freeze` if the drift is intentional; investigate if not.                                                                                                              |

## Beyond the script

The script checks structure; the agent running this flow also checks
meaning:

- **Unlogged deviations:** compare recent member-repo history on bound
  stacks against `plan/tasks.md` and the newest journal sections. Work that
  changed direction without a journal entry gets one now (backfilled and
  marked as such).
- **Stale ADR index:** every `accepted` ADR should still describe reality;
  an ADR contradicted by merged code must be superseded.
- **Stack hygiene:** `workspace.ts stacks` output should match the task
  registry — stacks with no task row, or task rows whose stacks vanished,
  are drift.
- **Skill links:** every skill in the manifest's `skills:` list should
  resolve through `<hub>/.claude/skills/<name>` as a relative symlink to
  `../../skills/<name>`. Missing or dangling links: re-run the
  project-local linking step from init.md. The hub's skills must NOT be
  linked globally (`~/.claude/skills/` or `~/.agents/skills/`); a global link
  is drift, remove it.

Finish by reporting findings the way the enter flow reports state: what is
broken, what was fixed, what needs the user's decision.
