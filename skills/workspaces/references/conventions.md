# Workspace conventions

The rules that bind a workspace hub to its member repositories. They exist
because three different tools can create branches and worktrees, and because
agent context must stay explicit and auditable. Violations are what the
`audit` flow looks for.

## Binding by naming

The hub discovers its artifacts in member repos purely through naming, read
via `git -C` from outside any worktree:

Every artifact is named from one value: the task slug from the registry row in
`plan/tasks.md`. One slug, one name, all the way down.

- **Stacks:** `<stack-prefix><task-slug>` (default `<slug>/<task-slug>`).
  Stack metadata is git config in the repo's common dir
  (`stack.<name>.*`, `branch.<branch>.stack-name`), written by the
  stacked-prs skill. Stack names must never contain dots: they become
  git-config subsections and dots make key parsing ambiguous.
- **Branches:** `<branch-prefix><task-slug>`. Branch names are validated by
  git itself (`git check-ref-format`); slashes are fine.
- **Plan batches:** `plan/batches/<member>/<task-slug>/` in the hub.

Using the one slug throughout closes the loop and makes it traceable by
inspection: task registry row -> batch dir -> stack -> branches -> PRs.

## Worktree ownership: one creator per branch+worktree pair

Verified constraint: wt, stacked-prs, and task-orchestrator each know how to
create worktrees, and they do not coordinate. The workspace assigns
exclusive domains:

| Domain                     | Creator             | Notes                                                                                                                                           |
| -------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive / feature work | `wt` (worktrunk)    | Per-repo worktree paths via wt config; context injection via a **user** per-project `post-start` hook (project hooks need interactive approval) |
| Orchestrated batch runs    | `task-orchestrator` | Raw `git worktree add` under `.claude/worktrees/<batch>/<task-id>`, local-excluded                                                              |
| Stack metadata             | stacked-prs         | Metadata only. Never use its `--create-worktree` options in a workspace                                                                         |

Two hard rules that follow:

1. Never run stacked-prs `create` for a child branch from inside a
   wt-managed worktree: it runs `git checkout -b` in place and moves that
   worktree's HEAD off its assigned branch. Create/register the branch
   first, then materialize it with `wt switch <branch>`.
2. Do not point task-orchestrator and wt at the same branch. One unit of
   work, one creator.

## Member repository purity

The workspace is a personal developer workflow tool, not an
organization-adopted system. Member repositories must show no committed
evidence of it:

- **Allowed residue:** local-excluded runtime dirs
  (`.claude/worktrees/`, `.claude/task-orchestrator/`), git config (stack
  metadata), and user-level wt hooks. None of these appear in `git status`
  or history.
- **Forbidden:** committed plan files, workspace docs, generated context, or
  tracked files under the runtime dirs. `audit` flags tracked runtime files
  as `member-workflow-artifacts`.

## Decision and deviation recording

- ADRs live in the hub at `docs/adr/NNNN-slug.md` (domain-modeling's
  convention) with MADR-style lifecycle semantics: status moves
  proposed -> accepted -> superseded/deprecated; a superseded ADR gains a
  forward link and is never edited.
- Every deviation from a recorded plan, spec, or ADR gets a JOURNAL.md entry
  before or with the change, cross-linked three ways (plan/phase, ADR,
  member PR/commit). Redesigns are not failures; unrecorded redesigns are.
- Phase exit criteria changes are Decisions and are journaled.

## Context discipline

- `workspace.yaml` is the only source of truth; `CLAUDE.md` is generated.
  To change context, edit the manifest and run `just sync` — the diff of the
  generated file is the audit trail.
- `docs/index.md` is the curated allow-list. A document not reachable from
  the index is not context, no matter where it sits.
- Context layers load in manifest order: constitution -> spec -> decisions ->
  phasing -> tasks -> conventions. Later layers may narrow, never contradict,
  earlier ones; a contradiction is a Decision to record.
