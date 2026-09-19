# Starting an implementor session

All paths below: `<repo>` is the repository root, `<run>` is the run folder,
`<base>` is the local integration branch, and `NN` is the zero-padded ticket.

The coordinator performs every mechanical step through the versioned helper
contract in [helper-cli.md](helper-cli.md). It never assembles a shell command
for a harness process.

## 1. Resolve repository policy

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
The helper records the portable defaults:

- multiple commits are allowed;
- fix rounds append commits.

Repository policy may instead resolve `single` or `squash` commit shape and
`amend` or `squash` fix behavior. Record the resolved values, do not infer them
again during review.

After resolving this policy, invoke `worktree.preflight` with the complete
`policy` object. It is read-only and must succeed before RESUME.md or any
worktree is created. A missing repository-required tool stops here without
native fallback.

Then invoke `worktree.prepare`:

```json
{
  "schema_version": 1,
  "operation": "worktree.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "repository_path": "/repo",
    "base_branch": "main",
    "branch": "feature/ticket-04",
    "worktree_name": "ticket-04",
    "policy": {
      "instruction_files": ["CLAUDE.md"],
      "worktree": {
        "kind": "native",
        "tool": null,
        "root": "/worktrees/example",
        "create_argv": null
      },
      "branch_naming": "feature/ticket-NN",
      "setup_argvs": [],
      "cleanup": "native-safe",
      "remote": "local-only",
      "commit": null
    }
  }
}
```

For repository tooling, also pass `expected_worktree_path`. The helper validates
that the prescribed command produced the requested branch at that exact path.
On retry, an already matching worktree is recovered rather than recreated.

## 2. Create the Herdr tab

Create the worker tab at the prepared worktree so the harness starts in the
correct project:

```text
herdr tab create --workspace <workspace> --cwd <worktree> --label "implement <prefix> NN <slug>" --no-focus
```

Use the machine-readable result to capture the actual tab and root pane ids.
Do not guess compact Herdr ids.

## 3. Prepare a shell-free launch

Call `implementor.launch.prepare` with the actual worktree, branch, session,
tab, and pane. The operation:

1. validates the requested role against the installed harness and the run-wide
   `Implementor:` record while holding the state lock;
2. verifies the worktree and branch;
3. constructs Herdr and harness argument arrays;
4. writes an inspectable JSON launch artifact;
5. binds the role into the ticket row;
6. records the runtime block before any process starts, with `Implementor:` as
   compact JSON containing exactly `harness`, `model`, and `effort`.

The JSON role binding preserves custom model values byte-for-byte, including
spaces, and recovery parses it structurally rather than splitting display text.

Pi additionally requires the installed `implement/SKILL.md` path. The start
array includes `--approve` and `--skill <path>`, and the prompt begins with
`/skill:implement`. Claude Code uses `--permission-mode auto`, and its prompt
begins with `/implement`. The required skill is fixed by the workflow and is
not an arbitrary run preference.

```json
{
  "schema_version": 1,
  "operation": "implementor.launch.prepare",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "artifact_path": ".scratch/example/briefs/launch-04.json",
    "ticket": "04",
    "worktree_path": "/worktrees/example/ticket-04",
    "branch": "feature/ticket-04",
    "session": "example-04",
    "tab": "implement example 04",
    "pane": "w1:p4",
    "role": {
      "harness": "pi",
      "model": "openai-codex/gpt-5.6-sol",
      "effort": "high"
    },
    "implement_skill_path": "/home/user/.pi/agent/skills/implement/SKILL.md",
    "prompt": "You are implementing ticket 04...",
    "attempt": 1,
    "max_attempts": 3
  }
}
```

The result contains two command objects, each with `command` and `args`. Execute
them as process argument arrays in order: `launch.start`, then `launch.prompt`.
Do not join, quote, interpolate, or pass them through `sh -c`. Paths, Unicode,
apostrophes, leading dashes, and prompt text remain single arguments.

## 4. Record the observed outcome

After executing the two arrays, call `implementor.launch.record`.

For success:

```json
{
  "schema_version": 1,
  "operation": "implementor.launch.record",
  "input": {
    "state_path": ".scratch/example/RESUME.md",
    "ticket": "04",
    "attempt": 1,
    "status": "started",
    "diagnostic": null
  }
}
```

For failure, pass `status: failed` and the exact stage, exit code, and stderr.
The helper keeps the runtime block active and records `Phase: launch failed`.
Then call `infrastructure.retry.record` for the same ticket and attempt. It
returns either the next bounded delay and exact persisted binding, or
`action: block` after three retries are exhausted. It never changes harness,
model, effort, required skill, worktree, or branch.

For `action: retry`, wait the returned delay and call
`implementor.launch.prepare` with the next attempt number, a new attempt-specific
artifact path, and the exact returned binding. The schema-1 `max_attempts` field
is retained for compatibility and must be `3`, meaning three retries after the
initial launch. Attempts therefore run from 1 through 4. A retry is not
permission to substitute a model or tool.

## 5. Recover a partial launch

Recovery is state-first:

1. Read the ticket row and active runtime block.
2. Verify the recorded worktree and branch.
3. Parse the active runtime's compact JSON `Implementor:` value and require the
   exact harness, model, and effort, including any spaces in the model.
4. Read the recorded JSON artifact.
5. Refresh the current Herdr pane id from Herdr.
6. If preparation completed but no process started, call
   `implementor.launch.prepare` again with the same attempt. It returns
   `recovered: true` and the same argument arrays.
7. If the agent exists but the outcome write was interrupted, inspect Herdr and
   call `implementor.launch.record` with the observed result.
8. If the prior attempt failed, call `infrastructure.retry.record`. Only when it
   returns `action: retry` prepare the next attempt from its exact binding.

A conflicting persisted role, branch, worktree, required skill path, or
attempt fails recovery without creating an artifact or changing state. An
already-existing identical artifact is preserved. Do not rewrite the runtime
to match conversational memory.
