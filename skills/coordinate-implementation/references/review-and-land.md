# Review, fix loop, and landing

## Synchronize before review

Parallel workers branch from the landed base that existed when they started.
Once a worker is idle with its policy-compliant commits, synchronize that branch
to the latest local integration branch before running final gates or reviews.
Do not fetch or assume a remote unless the persisted Repository policy requires
that exact synchronization.

Only one ticket may be in this synchronize, review, and land sequence at a
time. Process ready tickets in dependency order. This keeps each review diff
limited to that ticket instead of making later base commits appear as reversals.

Resolve textual conflicts yourself with the `resolving-merge-conflicts` skill,
never by asking the implementor to operate the rebase. Preserve the intent of
both the landed change and the ticket. If that cannot be done without a scope
decision, stop and ask the user. After the rebase completes, update the active
ticket's `Branch` and `Phase` fields, and verify the commit shape on
`<base>..HEAD` against the persisted Repository policy.

A clean textual resolution is coordination work. A substantive behavioral
adaptation is implementation work: send it to the same worker as a fix round,
have the worker follow the persisted fix-commit policy, then synchronize again
if needed and run the full gates and review.

## Gates

Read the resolved `Verification` section in `<run>/briefs/common.md`. Run every
required final gate exactly as recorded, from the ticket worktree, before
spawning reviewers. Use the repository's background command facility for a
long-running gate when one is available.

If the shared brief still contains a placeholder, an unverified command, or no
explicit statement that the repository has no executable gate, stop. Resolve
the brief from repository instructions and CI configuration before reviewing.
Do not infer a toolchain from file extensions or reuse commands remembered from
another repository.

A commit that fails a gate goes back to the worker as the first fix item, with
the failing command and relevant output.

## Review

Preconditions: the commits on `<base>..HEAD` satisfy the persisted Repository
policy, the worktree is clean, and all recorded gates are green.

Spawn two review agents in one message, both given the diff range
`<base>..<branch>` and the worktree path:

- **Standards axis**: Review against the repository instruction, architecture,
  domain, and contract documents named in `<run>/briefs/common.md`. Report only
  actionable findings with `file:line` locations.
- **Spec axis**: Review the sections of `<run>/spec.md` named by the ticket and
  every checkbox in `<run>/issues/NN-*.md`. State which earlier tickets already
  landed so the reviewer can distinguish scope creep from verified prior work.

Do your own read of the diff against the acceptance checkboxes. If the project
provides domain-specific review skills, load only the ones relevant to the
changed files. Do not assume a framework, language, architecture, or review
baseline that the repository does not declare.

## Fix loop

Compose **one** request per round. Short requests go straight to the pane. Write
long requests to `<run>/briefs/fixes-NN.md` and point the pane at the file.
Every request ends with:

> Apply the persisted fix-commit policy, rerun the gates recorded in the shared
> brief, and print `FIXES DONE NN`.

Include the implementor in the next wait-any call. When it returns a terminal
status, verify mechanical items directly, spawn one verification agent for
judgment items, and rerun the recorded gates.
Two rounds is normal. A ticket still failing review after a **third** round
triggers the escalation rule in the skill, per ticket, logged, and gated on
`Coordinator.unattended`. This is separate from crash-restart. Increment the
ticket row's `rounds` column each round.

## Landing

After review, land immediately from the recorded `<base checkout>`:

```sh
cd <base checkout> && git merge --ff-only <branch>
```

The fast-forward is the serialization point. If it is refused, `<base>` moved
after this ticket's review. Return to the ticket worktree, fetch and rebase on
the latest `<base>`, resolve textual conflicts as described above, and rerun
all recorded gates. Then repeat both review axes, focused on the interaction
with commits that landed since the full review and on any conflict-resolution
hunks. If either axis finds that the ticket needs substantive adaptation, send
a fix round to the same implementor, rerun the full gates and both review axes,
and only then retry the fast-forward. The rebase-and-retry loop serializes
landings without a lock file.

Then close the worker tab and finish the worktree lifecycle according to the
persisted Repository policy:

```sh
herdr tab close <tab>
```

A repository-required cleanup tool is authoritative. The native fallback first
verifies that the worktree is clean and the branch is landed, removes the
worktree without force, and retains the branch. Never silently change cleanup
tools or delete a retained branch.

Set the ticket row's `status` to `landed`
and fill its `sha`, leaving its bound record columns untouched as provenance.
Remove its `## Active tickets` block, update `Base sha:`, log any scope decision
in `## Decisions`, and update `.scratch/coordinators.md`. Then call
`scheduler.plan`; it immediately fills newly available implementor capacity in
deterministic ticket order.

## Scope decisions

When a ticket includes sound work that a later ticket expected to own, keep it
and narrow the later ticket to verify what remains before implementing more.
Record the decision in `## Decisions` and in the later ticket's
`IMPORTANT CONTEXT` clause. Unwinding usually costs more than a narrowed
follow-up.

A scope decision always waits for the user. `Coordinator.unattended` does not
authorize it.
