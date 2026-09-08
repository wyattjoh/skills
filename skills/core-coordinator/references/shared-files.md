# Shared-file ownership and merge order

## Finding contention

- `git status --short` in the main checkout: uncommitted edits there belong to
  some coordinator or to the user; ask before assuming.
- For each base: `git log --oneline main..<base>` and
  `git log --oneline <base>..main` show what each side carries.
- `git diff --stat main...<base>` per run, plus `git diff --stat <base>..HEAD`
  in each active ticket worktree, gives the footprint. Ticket prose rarely
  names paths; the worktree diff and the coordinator's own answer do.

Files that contend in practice: `CLAUDE.md`, `DESIGN.md`, `.claude/rules/*`,
`.claude/skills/*` (the coordinators edit their own procedure while running
it), root `Cargo.toml`/`Cargo.lock`, the CI workflow, `README.md`.

## Resolving

1. Name one owner per shared file or directory, usually the run whose
   footprint there is largest or that merges first. Record it in RESUME.md
   and the registry's cross-run section, and tell every run.
2. A non-owner's needed edit is messaged to you; you pass it to the owner to
   fold in, or, when the user decides so, commit it straight onto `main` as a
   conventional-commit docs change and have every run merge `main`. The owner
   reconciles its own version on that merge, keeping both where they
   complement each other.
3. Ask each run for the merge sha and record it. All bases at the same
   `main` sha is the resting state.

## Merge order

Widest footprint first. A framework or toolchain swap that rewrites every
import under a directory goes to `main` before any run whose tickets touch
that directory, and those runs merge `main` before their affected tickets.
Core-only runs that land continuously on their own base go ahead of the swap
and absorb the port at whichever ticket is in flight when the swap lands.
Doc-only edits are safe to merge into every base immediately.

Tell a run that wants notice before another run lands on `main` (to time its
own landing rebase) when that landing becomes imminent, not after.
