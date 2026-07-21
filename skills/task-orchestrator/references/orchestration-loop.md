# Orchestration loop — state machine and edge cases

Detailed reference for the coordinator. The SKILL.md Quick Start is the
entry point; this file covers the per-task state machine, agent contracts, and
the tricky merge/escalation cases.

## Per-task states

```
queued → running → review(r1..r3) → rebasing → verifying → merged
                        │                │           │
                        └── escalated ───┴───────────┘   (cap reached)
   blocked ── (a dependency escalated/failed, or this task returned blocked)
```

- **queued** — eligible deps not all merged yet, or waiting for a concurrency slot.
- **running** — implementer is producing the first commit.
- **review(rN)** — reviewer is judging round N (N ≤ 3).
- **rebasing** — implementer is rebasing onto current integration HEAD.
- **verifying** — coordinator is running the project verification command.
- **merged** — fast-forwarded into the integration branch; worktree pruned.
- **escalated** — 3 rounds without approval, or verification will not pass.
- **blocked** — a dependency did not merge, or the implementer returned `blocked`.

Mirror these into the Task-tool entry (live UI) **and** the state journal
(durable record) on every transition. The journal additionally carries the
`implementerAgent` / `reviewerAgent` handles, `round`, `outstandingComments`, and
`mergedSha` — the fields a compacted coordinator cannot otherwise reconstruct.
See the SKILL.md "State journal" and "Resumption" sections.

## Readiness and scheduling

A task is **ready** when every id in its `dependsOn` is in the merged set. After
each merge, recompute the ready set and start any newly-ready tasks up to the
concurrency cap. Branch each new worktree off **current integration HEAD** at
the moment it starts, so merged dependencies are already present in its base.

Because merges are serialized through you (the coordinator), integration HEAD
only advances between merges — dependent worktrees always branch off a
consistent base.

## Agent contracts

**Implementer** (`claude`, one per task, kept alive across rounds):

- Input: the plan content, the worktree absolute path (its working directory),
  and on later rounds the reviewer's comments via `SendMessage`.
- Must: implement strictly within the worktree, commit, self-verify, and return
  `{ status: "done" | "blocked", summary }`.
- Reused for: fix rounds, the rebase onto integration HEAD, and conflict
  resolution. Do not spawn a fresh implementer per round — context is the point.

**Reviewer** (`pr-review-toolkit:code-reviewer`, one per task, kept alive):

- Input: the worktree diff, the task plan (prefer an explicit "acceptance
  criteria" / "done when" section), and project conventions.
- Returns `{ verdict: "approved" | "changes_requested", comments }`.
- Reused across rounds so it can confirm its own prior comments were addressed,
  and to re-approve a conflict-resolved diff before merge.

## Merge sequence (per approved task)

1. Implementer rebases its branch onto current integration HEAD in the worktree.
2. **Clean** → go to step 4. **Conflict** → implementer resolves in-worktree,
   then reviewer re-approves the resolved diff (a resolution can change
   behavior). A re-approval that comes back `changes_requested` re-enters the
   fix loop under the same 3-round cap.
3. (only reached via conflict path) reviewer approved the resolved diff.
4. **Verification gate** — run the detected project check in the worktree
   (e.g. `bun run check && bun test`). Pass → step 5. Fail → bounce to the
   implementer like a conflict; counts against the 3-round cap. No detectable
   command → skip with an explicit note in the report.
5. Fast-forward merge the branch into the integration branch. Because the branch
   was just rebased onto integration HEAD and merges are serialized, the
   fast-forward is guaranteed unless another merge landed in between — if so,
   re-run from step 1.
6. Prune the worktree, delete the task branch, mark **merged**, recompute the
   ready set.

## Escalation handling

When a task **escalates** (3 rounds without approval, or verification cannot be
made to pass):

- Pause that task; do not merge anything unreviewed.
- Surface to the user: the task id, the diff, and the outstanding reviewer
  comments.
- Retain the worktree and report its path.
- Mark every transitive dependent **blocked** and report them — do not start
  them, since their base would be missing the escalated task's work.
- Continue running all unrelated ready tasks. The batch is fail-soft, not
  fail-fast.

## Concurrency notes

- Default cap is 3 simultaneous task pipelines. Each pipeline can hold two live
  agents (implementer + reviewer), so the cap also bounds live-agent count.
- Dispatch the implement and review steps so independent tasks overlap; do not
  serialize the whole batch behind one slow review loop.

## Final report

- **Merged**: ids and one-line summaries.
- **Escalated**: ids, retained worktree paths, outstanding comments.
- **Blocked**: ids and which dependency blocked them.
- Offer to open a PR for the integration branch (per the user's PR conventions),
  or to clean up retained worktrees once the user has inspected them.
