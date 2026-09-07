# Testing Effect v4 with @effect/vitest

A pragmatic guide for writing _deterministic_ tests against Effect v4. `@effect/vitest` shares the single ecosystem
version, so it must be `4.0.0-beta.107` when `effect` is.

## v3 to v4 Changes

| v3                                     | v4                                           |
| -------------------------------------- | -------------------------------------------- |
| `import { TestClock } from "effect"`   | `import { TestClock } from "effect/testing"` |
| `import { FastCheck } from "effect"`   | `import { FastCheck } from "effect/testing"` |
| `Effect.fork` in helpers               | `Effect.forkChild`                           |
| `TestContext` / `TestServices` modules | Removed                                      |

`effect/testing` also adds `TestConsole` and `TestSchema`.

## The #1 gotcha: `it.effect` uses `TestClock`

`it.effect` runs the test with a virtual clock.

Implications:

- Time starts at **0**.
- Time does **not** pass unless you advance it.
- Any `Effect.sleep(...)`, `Schedule.spaced(...)`, retry backoff, or polling loop will **stall forever** unless you
  call `TestClock.adjust(...)`.

Use `it.live` when wall-clock time is genuinely wanted.

```typescript
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

describe("timing", () => {
  it.effect("controls time with TestClock", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.sleep(60_000).pipe(Effect.as("done" as const)));

      yield* TestClock.adjust(60_000);

      const value = yield* Fiber.join(fiber);
      assert.strictEqual(value, "done");
    }),
  );

  it.live("uses real runtime services", () =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      yield* Effect.sleep(1);
      assert.isTrue(Date.now() >= startedAt);
    }),
  );
});
```

## Time: don't use `Date.now()` in Effect code

Production code calling `Date.now()` cannot be driven by `TestClock`. Use the Clock service:

```typescript
import { Clock, Effect } from "effect";

const program = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  return now;
});
```

For anything calendar-shaped, use the `DateTime` module rather than `Date`. It reads the current time through the
Clock, so it stays testable.

## Replace `Effect.sleep` with `TestClock.adjust` under `it.effect`

Instead of `yield* Effect.sleep("50 millis")`, write `yield* TestClock.adjust("50 millis")`. If real timers are
genuinely required, switch the whole test to `it.live`.

## Testing retries, backoff, and scheduled loops

Schedules do not progress under `TestClock` unless time is advanced. Fork, advance, then join:

```typescript
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

const runWithTime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  adjust: Duration.Input = "1000 millis",
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(adjust);
    return yield* Fiber.join(fiber);
  });
```

Advance _enough_ time for the whole backoff chain to complete.

## Parameterized and property tests

```typescript
it.effect.each([
  { input: " Ada ", expected: "ada" },
  { input: " Lin ", expected: "lin" },
])("normalizes %#", ({ input, expected }) =>
  Effect.gen(function* () {
    assert.strictEqual(input.trim().toLowerCase(), expected);
  }),
);

// Property-based tests use Schema-derived arbitraries.
it.effect.prop("reversing twice is identity", [Schema.String], ([value]) =>
  Effect.gen(function* () {
    assert.strictEqual(value.split("").reverse().reverse().join(""), value);
  }),
);
```

## Testing services with shared layers

`layer(...)` builds one layer for the whole block and tears it down in `afterAll`, so every test inside shares the
same context. State persists between tests in the block, which is sometimes what you want and sometimes a trap.

```typescript
import { assert, describe, it, layer } from "@effect/vitest";
import { Array, Context, Effect, Layer, Ref } from "effect";

// A Ref exposed as a service lets tests inspect and seed the store directly.
class TodoRepoTestRef extends Context.Service<TodoRepoTestRef, Ref.Ref<Array<Todo>>>()(
  "app/TodoRepoTestRef",
) {
  static readonly layer = Layer.effect(TodoRepoTestRef, Ref.make(Array.empty()));
}

class TodoRepo extends Context.Service<
  TodoRepo,
  {
    create(title: string): Effect.Effect<Todo>;
    readonly list: Effect.Effect<ReadonlyArray<Todo>>;
  }
>()("app/TodoRepo") {
  static readonly layerTest = Layer.effect(
    TodoRepo,
    Effect.gen(function* () {
      const store = yield* TodoRepoTestRef;

      const create = Effect.fn("TodoRepo.create")(function* (title: string) {
        const todos = yield* Ref.get(store);
        const todo = { id: todos.length + 1, title };
        yield* Ref.set(store, [...todos, todo]);
        return todo;
      });

      return TodoRepo.of({ create, list: Ref.get(store) });
    }),
    // provideMerge keeps the test Ref reachable from the tests themselves.
  ).pipe(Layer.provideMerge(TodoRepoTestRef.layer));
}

layer(TodoRepo.layerTest)("TodoRepo", (it) => {
  it.effect("creates a todo", () =>
    Effect.gen(function* () {
      const repo = yield* TodoRepo;
      yield* repo.create("Write docs");
      assert.strictEqual((yield* repo.list).length, 1);
    }),
  );

  it.effect("shares state across tests in the block", () =>
    Effect.gen(function* () {
      const repo = yield* TodoRepo;
      // The todo from the previous test is still here.
      assert.strictEqual((yield* repo.list).length, 1);
    }),
  );
});
```

Split a service's layer into a dependency-free part (`layerNoDeps`) and wired variants (`layer`, `layerTest`). Tests
then swap dependencies without redefining the service.

For per-test isolation instead, provide inside each test and opt out of shared memoization:

```typescript
it.effect("gets its own instance", () =>
  program.pipe(Effect.provide(MyService.layerTest, { local: true })),
);
```

This matters more in v4 than v3: layers are now memoized **across** `Effect.provide` calls, so two tests that each
provide the same layer on the same fiber will share one instance unless you use `local: true` or `Layer.fresh`.

## Streams, watches, and background fibers: always bound and clean up

Most test hangs come from one of these:

- A stream that never ends (`Stream.runCollect` on an infinite stream)
- A watch or polling loop forked and never interrupted
- A scoped resource whose scope never closes

Recommendations:

- Prefer bounded consumption: `Stream.take(stream, n)`, `Stream.takeUntil(...)`, `Stream.haltWhen(...)`.
- Interrupt every forked fiber on all paths with `Fiber.interrupt`, or run it in a `Scope` and let finalizers do it.
- Wrap anything that could block in `Effect.timeout(...)`.

## Concurrency gotcha: `forkChild` does not mean "the fiber has started"

Forking schedules a fiber; the scheduler may not run it yet. A test that forks two fibers and immediately opens a
gate can go effectively sequential, making assertions about overlap flaky.

Add a `started` latch that the work signals as soon as it begins:

```typescript
import { Deferred, Effect, Fiber } from "effect";

Effect.gen(function* () {
  let executions = 0;

  const started = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();

  const underlying = Effect.gen(function* () {
    executions++;
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(gate);
    return "ok";
  });

  const f1 = yield* Effect.forkChild(underlying);
  const f2 = yield* Effect.forkChild(underlying);

  // Don't open the gate until at least one fiber definitely started.
  yield* Deferred.await(started);
  yield* Deferred.succeed(gate, undefined);

  yield* Fiber.join(f1);
  yield* Fiber.join(f2);
});
```

Note that `Deferred` is no longer an Effect in v4: `yield* deferred` does not work, use `Deferred.await(deferred)`.

Alternatively, fork with `{ startImmediately: true }` when you want the fiber to begin before the fork returns.

## Use `it.scoped` when the test allocates scoped resources

If the test or the code under test uses `Effect.acquireRelease`, `Stream.scoped`, or resourceful layers, prefer
`it.scoped` / `it.scopedLive` so finalizers run when the test completes.

## Don't escape the test runtime inside an Effect test

Avoid calling `Effect.runPromise(...)` inside an `it.effect` program. It runs work on a different runtime with a live
clock, defeating `TestClock` determinism. Pass Effects around and `yield*` them; if a Promise boundary is genuinely
needed, put it at the test boundary.

## Flaky tests

`@effect/vitest` exports `flakyTest` for wrapping an effect that is expected to need retries, and `addEqualityTesters`
to register Effect's structural equality with Vitest's matchers. Note that `Equal.equals` is structural by default in
v4, so some v3 assertions that relied on reference inequality will now pass unexpectedly.

## Quick decision table

- Uses timeouts, sleeps, retries, or polling? Use `it.effect` plus `TestClock.adjust(...)`.
- Needs wall clock, Node timers, or real delays? Use `it.live` or `it.scopedLive`.
- Allocates resources that must be finalized? Use `it.scoped` or `it.scopedLive`.
- Needs a shared service context across a block? Use `layer(MyLayer)("name", (it) => ...)`.
- Needs a fresh instance per test? Provide inside the test with `{ local: true }`.
