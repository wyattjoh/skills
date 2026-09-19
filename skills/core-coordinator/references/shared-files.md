# Shared-file ownership and merge order

## Finding contention

- `git status --short` in the canonical integration checkout: uncommitted edits
  there belong to the user or another authorized workflow; ask before assuming.
- For each recorded base, compare its local commit range with the shared
  integration branch selected by repository policy.
- `git diff --stat <common-base>...<run-base>` per run, plus the local
  integration-base-to-ticket-tip diff in each active ticket worktree, gives the
  footprint. Ticket prose rarely names every path, so combine both sources.

Treat repository instructions, dependency manifests, lockfiles, CI
configuration, generated indexes, and top-level documentation as likely shared
files. The actual repository contract, not this skill, decides the paths.

## Resolving

1. Name one owner per shared file or directory, usually the run whose
   footprint there is largest or that merges first. Record it in RESUME.md
   and the registry's cross-run section, and tell every run.
2. A non-owner's needed edit is messaged to you; pass it to the owner to fold
   in. When the user chooses a different integration path, relay that decision
   to the affected run owners. The core coordinator never commits the edit or
   changes another run's base.
3. Ask each run for the resulting local base SHA and record it. Runs apply
   synchronization through their own persisted repository policy. Do not
   assume a remote, fetch, or a branch named `main`.

## Merge order

Widest footprint first. A framework or toolchain swap that rewrites every
import under a directory reaches its recorded local integration branch before
any run whose tickets touch that directory. Affected run owners then apply the
repository's persisted base-synchronization policy before their next ticket.
Core-only runs that land continuously may go ahead of the swap and absorb the
port at the policy-approved boundary.

Tell a run that wants notice before another run lands on the shared integration
branch when that landing becomes imminent, not after.
