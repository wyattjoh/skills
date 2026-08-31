# Migrating Effect v3 to v4

Condensed rename tables for the APIs that appear most often. The authoritative, exhaustive map is
`$SKILL_DIR/.source/migration/v3-to-v4.md` (very large, grep it). Per-topic guides live alongside it in
`$SKILL_DIR/.source/migration/`.

## Structural Changes First

Four changes affect whole files rather than single call sites. Handle them before chasing individual renames.

1. **Single version across the ecosystem.** `effect`, `@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`,
   `@effect/vitest`, `@effect/opentelemetry`, and `@effect/atom-*` all share one version number. Bump them together.
2. **Package consolidation.** `@effect/platform`, `@effect/rpc`, `@effect/cluster`, `@effect/cli`, `@effect/ai`, and
   `@effect/experimental` were merged into `effect`. Most land under `effect/unstable/*`; a few graduated to the top
   level.
3. **Unstable namespace.** `effect/unstable/*` modules may break in minor releases. Modules outside it follow strict
   semver.
4. **Effect subtyping removed.** See the Yieldable section in `critical-rules.md`. This is the change most likely to
   produce a wall of type errors.

## Module Moves

| v3 import                     | v4 import                          |
| ----------------------------- | ---------------------------------- |
| `effect/Either`               | `effect/Result`                    |
| `effect/JSONSchema`           | `effect/JsonSchema`                |
| `effect/FiberRef`             | `effect/References`                |
| `effect/TestClock`            | `effect/testing/TestClock`         |
| `effect/FastCheck`            | `effect/testing/FastCheck`         |
| `@effect/platform/FileSystem` | `effect/FileSystem`                |
| `@effect/platform/Path`       | `effect/Path`                      |
| `@effect/platform/Terminal`   | `effect/Terminal`                  |
| `@effect/platform/Error`      | `effect/PlatformError`             |
| `@effect/platform/HttpClient` | `effect/unstable/http/HttpClient`  |
| `@effect/platform/MsgPack`    | `effect/unstable/encoding/Msgpack` |
| `@effect/platform/Ndjson`     | `effect/unstable/encoding/Ndjson`  |
| `@effect/cli/Args`            | `effect/unstable/cli/Argument`     |
| `@effect/cli/Options`         | `effect/unstable/cli/Flag`         |
| `@effect/ai/*`                | `effect/unstable/ai/*`             |
| `@effect/cluster/*`           | `effect/unstable/cluster/*`        |
| `@effect/rpc/*`               | `effect/unstable/rpc/*`            |
| `@effect/sql/*`               | `effect/unstable/sql/*`            |

The STM family was renamed to `Tx*`: `TRef` to `TxRef`, `TMap` to `TxHashMap`, `TSet` to `TxHashSet`, `TQueue` to
`TxQueue`, `TPubSub` to `TxPubSub`, `TDeferred` to `TxDeferred`, `TSemaphore` to `TxSemaphore`,
`TSubscriptionRef` to `TxSubscriptionRef`, `TPriorityQueue` to `TxPriorityQueue`, `TReentrantLock` to
`TxReentrantLock`. The `STM` module itself is gone.

Removed with no direct replacement: `Micro`, `List`, `RedBlackTree`, `SortedMap`, `SortedSet`, `MutableQueue`,
`Reloadable`, `RateLimiter`, `KeyedPool`, `Supervisor`, `Secret` (use `Redacted`), `Mailbox` (use `Queue`),
`ParseResult`, `Pretty`, `Arbitrary`, `GlobalValue`, `RuntimeFlags`, and the `Test*` service modules.

New in v4: `Filter`, `Result`, `UndefinedOr`, `Optic`, `Newtype`, `Latch`, `Semaphore`, `Pull`, `LayerRef`,
`JsonPatch`, `JsonPointer`, `Combiner`, `Reducer`, `Redactable`, `ErrorReporter`, `Stdio`, and the `Schema*` family
(`SchemaError`, `SchemaGetter`, `SchemaIssue`, `SchemaParser`, `SchemaRepresentation`, `SchemaTransformation`).

## Services

| v3                                    | v4                                      |
| ------------------------------------- | --------------------------------------- |
| `Context.GenericTag<T>(id)`           | `Context.Service<T>(id)`                |
| `Context.Tag(id)<Self, Shape>()`      | `Context.Service<Self, Shape>()(id)`    |
| `Effect.Tag(id)<Self, Shape>()`       | `Context.Service<Self, Shape>()(id)`    |
| `Effect.Service<Self>()(id, opts)`    | `Context.Service<Self>()(id, { make })` |
| `Context.Reference<Self>()(id, opts)` | `Context.Reference<T>(id, opts)`        |

Note the argument order flip in the class form: v3 passes the identifier first, v4 passes the type parameters first
and the identifier to the returned constructor.

`Effect.Service`'s auto-generated `.Default` layer and its `dependencies` option are both gone. Build layers
explicitly with `Layer.effect` and wire dependencies with `Layer.provide`. v4 names the primary layer `layer` rather
than `Default` or `Live`.

Accessor proxies (v3 `Effect.Tag` statics) were removed because they erased generics and overloads. Use `yield*`, or
`Service.use` / `Service.useSync` where a one-liner is worth the hidden dependency.

## Error Handling

| v3                       | v4                        |
| ------------------------ | ------------------------- |
| `Effect.catchAll`        | `Effect.catch`            |
| `Effect.catchAllCause`   | `Effect.catchCause`       |
| `Effect.catchAllDefect`  | `Effect.catchDefect`      |
| `Effect.catchSome`       | `Effect.catchFilter`      |
| `Effect.catchSomeCause`  | `Effect.catchCauseFilter` |
| `Effect.catchSomeDefect` | Removed                   |

`catchTag`, `catchTags`, and `catchIf` are unchanged. `catchFilter` takes a `Filter` instead of a function returning
`Option`:

```typescript
Effect.catchFilter(
  Filter.fromPredicate((error: number) => error === 42),
  (error) => Effect.succeed("caught"),
);
```

New: `Effect.catchReason` and `Effect.catchReasons` handle a tagged `reason` inside an error without removing the
parent error from the error channel. `Effect.catchEager` evaluates synchronous recovery immediately.

## Cause

`Cause<E>` is now `{ reasons: ReadonlyArray<Fail<E> | Die | Interrupt> }`. The `Empty`, `Sequential`, and `Parallel`
variants are gone; an empty cause is an empty array, and composition concatenates.

| v3                              | v4                                     |
| ------------------------------- | -------------------------------------- |
| `Cause.isFailure(c)`            | `Cause.hasFails(c)`                    |
| `Cause.isDie(c)`                | `Cause.hasDies(c)`                     |
| `Cause.isInterrupted(c)`        | `Cause.hasInterrupts(c)`               |
| `Cause.isInterruptedOnly(c)`    | `Cause.hasInterruptsOnly(c)`           |
| `Cause.isEmptyType(c)`          | `c.reasons.length === 0`               |
| `Cause.isFailType(c)`           | `Cause.isFailReason(reason)`           |
| `Cause.failureOption(c)`        | `Cause.findErrorOption(c)`             |
| `Cause.failureOrCause(c)`       | `Cause.findError(c)`                   |
| `Cause.dieOption(c)`            | `Cause.findDefect(c)`                  |
| `Cause.failures(c)`             | `c.reasons.filter(Cause.isFailReason)` |
| `Cause.sequential` / `parallel` | `Cause.combine`                        |

`findError` and `findDefect` return `Result`, not `Option`. Use `findErrorOption` for the `Option` variant.

Every `*Exception` class became `*Error`: `NoSuchElementException` to `NoSuchElementError`, `TimeoutException` to
`TimeoutError`, `IllegalArgumentException` to `IllegalArgumentError`, `ExceededCapacityException` to
`ExceededCapacityError`, `UnknownException` to `UnknownError`. `RuntimeException`, `InterruptedException`, and
`InvalidPubSubCapacityException` were removed.

## Forking

| v3                            | v4                  |
| ----------------------------- | ------------------- |
| `Effect.fork`                 | `Effect.forkChild`  |
| `Effect.forkDaemon`           | `Effect.forkDetach` |
| `Effect.forkScoped`           | unchanged           |
| `Effect.forkIn`               | unchanged           |
| `Effect.forkAll`              | Removed             |
| `Effect.forkWithErrorHandler` | Removed             |

All fork variants now take `{ startImmediately?: boolean, uninterruptible?: boolean | "inherit" }`.

## Fiber-Local State

`FiberRef`, `FiberRefs`, `FiberRefsPatch`, and `Differ` are gone. Fiber-local values are `Context.Reference`s.

| v3 FiberRef                         | v4 Reference                       |
| ----------------------------------- | ---------------------------------- |
| `FiberRef.currentLogLevel`          | `References.CurrentLogLevel`       |
| `FiberRef.currentMinimumLogLevel`   | `References.MinimumLogLevel`       |
| `FiberRef.currentLogAnnotations`    | `References.CurrentLogAnnotations` |
| `FiberRef.currentLogSpan`           | `References.CurrentLogSpans`       |
| `FiberRef.currentScheduler`         | `References.Scheduler`             |
| `FiberRef.currentMaxOpsBeforeYield` | `References.MaxOpsBeforeYield`     |
| `FiberRef.currentTracerEnabled`     | `References.TracerEnabled`         |
| `FiberRef.unhandledErrorLogLevel`   | `References.UnhandledLogLevel`     |

Read with `yield* References.X`. Replace `FiberRef.get` with a plain `yield*`, and both `FiberRef.set` and
`Effect.locally` with `Effect.provideService`, which scopes the value to the provided effect.

## Runtime

`Runtime<R>` is removed. Use `Context<R>`:

```typescript
// v3
const runtime = yield * Effect.runtime<Logger>();
Runtime.runFork(runtime)(program);

// v4
const services = yield * Effect.context<Logger>();
Effect.runForkWith(services)(program);
```

The `Runtime` module now holds only `Teardown`, `defaultTeardown`, and `makeRunMain`.

The core runtime keeps the process alive across suspensions on its own, so `runMain` is no longer required merely to
stop early exit. It is still recommended for signal handling, exit codes, and error reporting.

## Other Renames

| v3                                    | v4                                    |
| ------------------------------------- | ------------------------------------- |
| `Scope.extend`                        | `Scope.provide`                       |
| `Equal.equivalence`                   | `Equal.asEquivalence`                 |
| `Effect.all(_, { mode: "validate" })` | `Effect.all(_, { mode: "result" })`   |
| `Effect.either`                       | `Effect.result`                       |
| `Config.validate`                     | `Config.schema` or `Config.mapOrFail` |
| `Stream.catchAll`                     | `Stream.catch`                        |
| `Stream.repeatEffect`                 | `Stream.fromEffectRepeat`             |
| `Effect.gen(this, fn)`                | `Effect.gen({ self: this }, fn)`      |
| `unsafeX(...)`                        | `xUnsafe(...)`                        |

`Effect.partition` now requires a mapping function: `Effect.partition(items, (item) => effect)`.

## Equality Behaviour Change

`Equal.equals` is structural by default in v4 for plain objects, arrays, `Map`, `Set`, `Date`, and `RegExp`. In v3 it
was reference equality outside a `structuralRegion`. `Equal.equals(NaN, NaN)` is now `true`.

This silently changes behaviour rather than failing to compile. Audit any code that relied on reference identity, and
opt out with `Equal.byReference` or `Equal.byReferenceUnsafe` where needed.

## Suggested Migration Order

1. Bump every `effect` and `@effect/*` package to the same v4 version.
2. Fix imports: moved modules, `Either` to `Result`, platform modules into core.
3. Convert services: `Context.Tag` / `Effect.Service` to `Context.Service`, build layers explicitly.
4. Rename `catch*` and `fork*` call sites.
5. Fix Yieldable errors: `Ref`, `Deferred`, and `Fiber` accesses.
6. Replace `FiberRef` with `References` and `Effect.locally` with `Effect.provideService`.
7. Update `Cause` inspection to the flat `reasons` array.
8. Audit `Equal.equals` usage for the structural-by-default change.
9. Update tests: `TestClock` moved to `effect/testing`, and `Effect.fork` in helpers became `Effect.forkChild`.
