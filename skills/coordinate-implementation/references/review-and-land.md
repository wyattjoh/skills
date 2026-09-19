# Review, fix loop, and landing

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

Preconditions: exactly one commit on `<base>..HEAD`, a clean worktree, and all
recorded gates green.

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

> Amend the single commit (`git commit --amend`), rerun the gates recorded in
> the shared brief, and print `FIXES DONE NN`.

Then re-arm the monitor. When it settles, verify mechanical items directly,
spawn one verification agent for judgment items, and rerun the recorded gates.
Two rounds is normal. A ticket still failing review after a **third** round
triggers the escalation rule in the skill, per ticket, logged, and gated on
`Coordinator.unattended`. This is separate from crash-restart. Increment the
ticket row's `rounds` column each round.

## Landing

From the ticket worktree:

```sh
cd <worktree> && git fetch origin && git rebase <base>
```

Conflicts are resolved **by you** with the `resolving-merge-conflicts` skill,
never by the implementor. After a rebase with conflicts, rerun the gates.

From the recorded `<base checkout>`:

```sh
cd <base checkout> && git merge --ff-only <branch>
```

If the fast-forward is refused, another coordinator landed on `<base>` in the
meantime. Return to the ticket worktree, rebase on `<base>` again, rerun the
gates, and retry. The retry loop provides serialization without a lock file.

Then close the worker tab and finish the worktree lifecycle according to the
**coordinator's** harness:

```sh
herdr tab close <tab>
```

- **Claude Code:** Stay in the ticket worktree through the merge, then call
  `ExitWorktree` and choose removal. If a resumed coordinator is not currently
  inside it, call `EnterWorktree(path: <worktree>)` first. Native cleanup may
  remove both the worktree and its `worktree-*` branch.
- **Pi:** Return to `<repo>`, then remove the worktree through Pando:

  ```sh
  printf '%s\n' '{"schema_version":1,"input":{"branches":["<branch>"]}}' \
    | pando remove --input-output json
  ```

  Never pass `--force`. Pando retains the branch ref and runs pre-remove hooks.
  Do not delete the retained branch separately.

Never use raw `git worktree remove`. Set the ticket row's `status` to `landed`
and fill its `sha`, leaving its bound record columns untouched as provenance.
Log any scope decision in `## Decisions`, update `.scratch/coordinators.md`,
then start the next ticket and bind the current `Implementor:` into its row.

## Scope decisions

When a ticket includes sound work that a later ticket expected to own, keep it
and narrow the later ticket to verify what remains before implementing more.
Record the decision in `## Decisions` and in the later ticket's
`IMPORTANT CONTEXT` clause. Unwinding usually costs more than a narrowed
follow-up.

A scope decision always waits for the user. `Coordinator.unattended` does not
authorize it.
