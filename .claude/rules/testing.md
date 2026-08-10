---
description: Require positive and exact expectations in test files, and sanitized environments for git spawns
alwaysApply: true
---

# Git fixtures must sanitize the environment

Never spawn `git` from a test with the inherited environment. `git -C <dir>`
does not override `GIT_DIR`: when that variable is set, git resolves the
repository from the environment and treats `-C` as a plain chdir.

Spawn through the shared helper, which strips the repository-location
variables:

```ts
import { spawnGit } from "./git-env.ts";

const result = spawnGit(["-C", dir, "init", "-q", "-b", "main"]);
expect(result.exitCode).toBe(0);
```

This is not hypothetical. lefthook runs `bun test` from `pre-push`, and a hook
invoked inside a linked worktree gets `GIT_DIR` set to
`.git/worktrees/<name>`. Fixture helpers then wrote to the developer's real
repository: `git init` re-inited that gitdir, and because it has no work tree
it took `core.bare=true` into the _shared_ config, breaking every worktree.
Fixture commits landed on a real branch.

`git init` is the most dangerous call in a fixture, because it fails silently:
the fixture directory gets no `.git` at all, and the commits go elsewhere.

A regression guard lives in
`skills/workspaces/scripts/lib/git-env.test.ts`. It points `GIT_DIR` at a decoy
repository, runs a fixture through `spawnGit`, and asserts the decoy still has
exactly one commit and an empty tree.

Skills ship independently, so a skill outside `workspaces` duplicates the small
key list rather than importing across skill directories (see
`skills/herd/scripts/preflight.ts`).

# Positive test expectations

Do not use Bun's negation modifier in expectation chains.

State the expected result directly. Prefer exact strings, objects, arrays,
numeric exit codes, collection sizes, and mock call counts.

```ts
expect(result.exitCode).toBe(1);
expect(renderedItems).toEqual(["first", "second"]);
expect(onSave).toHaveBeenCalledTimes(0);
```

When the behavior under test is that a call completes without throwing, invoke
the function directly. The test runner will fail the test if the call throws.

```ts
createWatchSet(paths, onChange, debounceMs).close();
```

This keeps failures focused on the concrete behavior that changed and avoids
weak assertions that allow many unintended values to pass.

## Filesystem watcher tests

Do not create a native filesystem watcher and immediately write a file in a
unit test. Native watcher registration has no readiness handshake, so the first
event can be missed under parallel load.

Inject a controlled watcher through the fourth `createWatchSet` argument and
emit events synchronously before waiting for the debounced callback.

```ts
const controlled = createControlledWatcher();
const set = createWatchSet(paths, onChange, debounceMs, controlled.watchPath);

controlled.emit(paths[0]);
```

Keep real filesystem coverage for synchronous behavior such as skipping paths
that do not exist. This preserves integration coverage without depending on OS
event delivery timing.
