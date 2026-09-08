# Review, fix loop, and landing

## Gates (CI's exact invocations)

Run in the worktree, in the background, before spawning reviewers:

```sh
cd <worktree> && export PATH="$HOME/.cargo/bin:$PATH" && just crsqlite && \
cargo fmt --all -- --check && \
cargo clippy --workspace --all-targets --all-features -- -D warnings && \
bun scripts/check-agent-architecture.ts && \
just test
```

There are no pre-commit hooks. A commit that fails any gate goes back to the
session as the first fix item, with the failing output pasted.

## Review

Preconditions: exactly one commit on `<base>..HEAD`, clean tree.

Spawn two `general-purpose` agents in one message, both given the diff range
`<base>..<branch>` in the worktree path:

- **Standards axis**: CLAUDE.md, DESIGN.md, `.claude/rules/*.md`, and the
  Fowler code-smell baseline. Report only actionable findings with file:line.
- **Spec axis**: `<run>/spec.md` sections the ticket names plus every
  checkbox in `<run>/issues/NN-*.md`. Tell it which earlier tickets already
  landed so it can separate scope creep from verified prior work.

Do your own read of the diff against the checkboxes as well. Review agents'
reports arrive as messages, often twice; act on the first.

For grid, dialog, or theme code load `gpui` / `gpui-component`. For seam and
entry-point tickets load `codebase-design` for vocabulary.

## Fix loop

Compose **one** request per round. Short requests go straight to the pane;
long ones are written to `<run>/briefs/fixes-NN.md` with the Write tool and
the pane is pointed at the file. Every request ends with:

> Amend the single commit (`git commit --amend`), rerun the gates, and print
> `FIXES DONE NN`.

Then re-arm the monitor. When it settles: grep-verify mechanical items
yourself, spawn one verification agent for the judgment items, rerun gates.
Two rounds is normal; a third suggests the fallback-model rule.

## Landing

From the ticket worktree:

```sh
cd <worktree> && git fetch origin && git rebase <base>
```

Conflicts are resolved **by you** with the `resolving-merge-conflicts` skill,
never by the implementor. After a rebase with conflicts, rerun the gates.

From the base checkout (the main checkout when `<base>` is `main`, otherwise
`.claude/worktrees/wyattjoh/<base>`):

```sh
cd <base checkout> && git merge --ff-only wyattjoh/<prefix>-NN-<slug>
```

If the fast-forward is refused, another coordinator landed on `<base>` in
between: go back to the ticket worktree, `git rebase <base>` again, rerun the
gates, and retry. No lock file; the retry loop is the serialization.

Then:

```sh
cd <repo>
printf '%s\n' '{"schema_version":1,"input":{"branches":["wyattjoh/<prefix>-NN-<slug>"]}}' | pando remove --input-output json
herdr tab close <tab>
```

Worktree removal goes through `pando remove` (user decision 2026-09-04), never
raw `git worktree remove`: it keeps the branch ref and runs pre-remove hooks.
Never pass `--force`. Do not delete the branch. Record the landed sha, fix-round count, and any
scope decision in RESUME.md's table, update `.scratch/coordinators.md`, then
start the next ticket.

## Scope decisions

When a ticket pulls in later tickets' work and the result is sound, keep it
and shrink the later tickets to verify-then-implement what remains. Record the
decision in RESUME.md and in the later tickets' `IMPORTANT CONTEXT` clause.
Unwinding costs more than a narrowed follow-up.
