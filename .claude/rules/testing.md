---
description: Require positive and exact expectations in test files
alwaysApply: true
---

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
