# Starting implementor sessions

`<repo>` is the repository root, `<run>` the run folder, `<base>` the local
integration branch, and `NN` the zero-padded ticket.

The coordinator resolves and persists repository policy before it starts the
Engine. The Engine then launches every implementor and retry through the
helper operations in [engine-operations.md](engine-operations.md) and never
assembles a shell command for a harness process. Never launch an implementor by
hand while an Engine holds the run's lease.

## Resolve repository policy

Before creating any worktree, read the repository instruction files that govern:

- worktree tooling and root;
- branch naming;
- setup and cleanup;
- remote synchronization;
- commit shape and rewrite policy.

Repository instructions are authoritative. Pass their paths in
`policy.instruction_files` so the accepted resolution is inspectable in
RESUME.md.

When the instructions prescribe a worktree tool, pass `kind: repository`, the
required tool, and its exact create argument array. The helper verifies that the
tool is available and invokes only that array. An unavailable required tool
stops the ticket. Never replace it with native Git.

When the instructions do not prescribe a lifecycle tool, ask the user for a
worktree root during initial setup and pass `kind: native`. The helper uses
`git worktree add` with a sanitized environment. It does not assume an
optional worktree product, a remote, or a directory layout.

When repository instructions do not define commit shape, pass `commit: null`.
The helper records the portable defaults: multiple commits are allowed and fix
rounds append commits. Repository policy may instead resolve `single` or
`squash` commit shape and `amend` or `squash` fix behavior.

Use `remote_sync_argv: null` for local-only policy. Repository remote policy
must persist the exact non-empty argv array that `landing.rebase.check` runs
before its ancestor check.

Invoke `worktree.preflight` with the complete `policy` object. It is read-only
and must succeed before RESUME.md or any worktree is created. Once RESUME.md
exists, repeat it with `state_path` so the helper persists the policy as
`## Repository policy`; the Engine reads that record before each launch.

## What the Engine does at launch

For each ticket the Engine creates the worktree (`worktree.prepare`), creates
tab `implement <prefix> NN <slug>` at that worktree (adopting an existing tab
with the same label after a restart), and calls `implementor.launch.prepare`.
That operation validates the role against the installed harness and the
ticket-row binding (or the run-wide `Implementor:` default for a new ticket),
writes an inspectable launch artifact, and records the runtime block, with its
`Implementor:` role as compact JSON, before any process starts.

Pi launches with `--approve --skill <implement SKILL.md>` and a prompt that
begins with `/skill:implement`. Claude Code launches with
`--permission-mode auto` and a prompt that begins with `/implement`. The Engine
executes the returned `launch.start` and `launch.prompt` argument arrays
exactly, then records the outcome with `implementor.launch.record`. A failed
launch goes through `infrastructure.retry.record`: attempts 1 through 4 reuse
the exact persisted binding, and the fourth failure parks the ticket with a
`retry_exhausted` escalation. A retry never substitutes a harness, model,
effort, skill, worktree, or branch.

## Recover a partial launch

After a restart the Engine reconciles a partial launch from RESUME.md and the
launch artifact without starting a second process. Manual recovery, with the
Engine stopped and explicit user authority, follows the same state-first
order: read the ticket row and runtime block, verify the worktree and branch,
parse the runtime's JSON `Implementor:` role exactly, read the artifact, and
refresh the pane id from Herdr. Then re-prepare the same attempt (it returns
`recovered: true` and the same arrays), record an observed outcome, or apply
`infrastructure.retry.record`, whichever step the state shows is missing.

If attempt 4 is already `retry exhausted`, do not prepare another launch or
restart an agent that is still alive. Only after the user explicitly confirms a
coordinator compatibility defect, use `implementor.launch.recover` as
[helper-cli.md](helper-cli.md) describes and execute only its returned
`prompt` array; never execute `start` during that recovery.

A conflicting persisted role, branch, worktree, required skill path, session,
pane, artifact, or attempt fails recovery without changing state. Do not
rewrite the runtime to match conversational memory.
