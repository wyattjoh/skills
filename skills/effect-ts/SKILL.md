---
name: effect-ts
description: Expert guidance for Effect v4 (4.0.0-rc.117, the npm "rc" dist-tag). Use when writing, reviewing, or refactoring code that imports from 'effect', when a project depends on effect@4.x, or when the user mentions "Effect", "Effect-TS", "Effect v4", "effect 4.0", "Context.Service", "Schema.TaggedError", "effect/unstable", "Yieldable", "forkChild", "Effect.catch", or asks to migrate an Effect v3 codebase to v4. Covers services, layers, error handling, streams, schema, and testing in the v4 API, plus a v3 to v4 migration map.
---

# Effect v4 Expert

Expert guidance for Effect v4, currently a release candidate at `4.0.0-rc.117` (npm `rc` dist-tag). v4 keeps the core programming model of v3
(`Effect`, `Layer`, `Schema`, `Stream`) but renames a large amount of the API surface, consolidates most of the
ecosystem into the `effect` package, and removes Effect subtyping.

**This is a prerelease.** APIs can still change between release candidates. Verify anything non-obvious against the pinned source rather
than recalling it.

## Prerequisites Check

Before starting any v4 work, verify the Effect v4 source exists at `$SKILL_DIR/.source/`.

If it is missing, clone it before proceeding and tell the user you did:

```bash
git clone --depth=1 --branch effect@4.0.0-rc.117 https://github.com/Effect-TS/effect.git "$SKILL_DIR/.source"
```

Pin the clone to the release tag this skill documents. If the project installs a different 4.x version, clone that
version's `effect@<version>` tag instead, so the source matches what the project runs. Cloning `main` unpinned
produces guidance that does not match any published version.

## Version Gate

Confirm which major the project is actually on before applying anything here:

```bash
node -p "require('./package.json').dependencies?.effect ?? require('./package.json').devDependencies?.effect"
```

- Resolves to `4.x` (including `-beta` / `-rc`): use this skill.
- Resolves to `3.x`: the v3 and v4 APIs are not interchangeable, so do not apply the v4 patterns here to v3 code.
  Follow the project's existing v3 code and the v3 source at the matching `effect@3.x` tag. If the user wants to
  upgrade, use [references/migration-from-v3.md](./references/migration-from-v3.md).
- All ecosystem packages share one version in v4. If `effect` is `4.0.0-rc.117`, then `@effect/platform-node`,
  `@effect/sql-pg`, and `@effect/vitest` must also be `4.0.0-rc.117`. Mismatched versions are a common source of
  confusing type errors.

## Canonical Upstream Documentation

The v4 repository ships authoritative docs that the v3 repository did not. **Read these before searching the source
tree**, they are the maintainers' own guidance and outrank any recalled pattern:

| Path in `$SKILL_DIR/.source/` | Contents                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| `LLMS.md`                     | Official "how to write Effect v4" guide written for coding agents         |
| `MIGRATION.md`                | v3 to v4 overview: versioning, package consolidation, unstable modules    |
| `migration/v3-to-v4.md`       | Generated import and API rename map (very large, grep it, do not read it) |
| `migration/services.md`       | `Context.Tag` to `Context.Service`                                        |
| `migration/error-handling.md` | `catch*` renamings                                                        |
| `migration/cause.md`          | Flattened `Cause` structure                                               |
| `migration/yieldable.md`      | Effect subtyping removal (stale on `Option`/`Result`, see below)          |
| `migration/forking.md`        | `fork` to `forkChild`, `forkDaemon` to `forkDetach`                       |
| `migration/fiberref.md`       | `FiberRef` to `Context.Reference`                                         |
| `migration/schema.md`         | Schema v4 migration                                                       |
| `ai-docs/src/`                | Runnable, type-checked examples grouped by topic                          |
| `ai-docs/src/06_schedule/`    | Schedule recipes                                                          |

Grep the rename map rather than reading it:

```bash
grep -n 'Effect.catchAll\|Stream.acquireRelease' "$SKILL_DIR/.source/migration/v3-to-v4.md"
```

## Research Strategy

1. **Codebase patterns first.** If the project already has v4 code, follow it. Check that it is v4 and not
   half-migrated v3.
2. **Upstream docs.** `LLMS.md` and `migration/*.md` as listed above.
3. **Source.** `$SKILL_DIR/.source/packages/effect/src/` for exact signatures. Unstable modules live under
   `src/unstable/`, test utilities under `src/testing/`.

Because v4 is a prerelease and pretrained knowledge of it is unreliable, verify a symbol exists before recommending it:

```bash
grep -rn "^export const someApi" "$SKILL_DIR/.source/packages/effect/src/Effect.ts"
```

## Core v4 Idioms

These are the maintainers' stated preferences from `LLMS.md`. Follow them by default.

### Write with `Effect.gen` and `Effect.fn`

Use `Effect.gen` for imperative-style composition, and attach behaviour with `.pipe`.

```typescript
import { Effect, Schema } from "effect";

Effect.gen(function* () {
  yield* Effect.log("Starting the file processing...");
  // Always `return yield*` when raising, so TypeScript knows execution stops here.
  return yield* new FileProcessingError({ message: "Failed to read the file" });
}).pipe(
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.withSpan("fileProcessing"),
);

export class FileProcessingError extends Schema.TaggedError<FileProcessingError>()(
  "FileProcessingError",
  {
    message: Schema.String,
  },
) {}
```

**Avoid functions that return `Effect.gen(...)`.** Use `Effect.fn` instead, which names the span and captures call
sites. Pass extra combinators as additional arguments; **do not `.pipe` an `Effect.fn`**.

```typescript
export const effectFunction = Effect.fn("effectFunction")(
  function* (n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n);
    return yield* new SomeError({ message: "boom" });
  },
  // Additional behaviour goes here, not in a .pipe on the result.
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({ method: "effectFunction" }),
);
```

`Effect.fnUntraced` is available when the tracing span is unwanted.

### Define errors with `Schema.TaggedError`

v4 prefers `Schema.TaggedError` over `Data.TaggedError` (which still exists). Schema errors are serializable, usable
in RPC and cluster boundaries, and validate their own payloads. Use `Schema.Defect()` for a field holding an unknown
cause.

```typescript
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}
```

### Model all validation with `Schema`

Do not hand-roll parsing or validation predicates. Decode untrusted input with `Schema`. For runtime type guards on
already-typed values, use the `Predicate` module (`Predicate.isObject`, `Predicate.isNumber`, composed with
`Predicate.and` / `or` / `not`) rather than writing `isRecord`-style helpers.

### Structure code as services

See [references/services-and-layers.md](./references/services-and-layers.md). The short version:

```typescript
export class Database extends Context.Service<
  Database,
  {
    query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>;
  }
>()("myapp/db/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const query = Effect.fn("Database.query")(function* (sql: string) {
        return [] as Array<unknown>;
      });
      return Database.of({ query });
    }),
  );
}
```

Identifier strings include the package name and path (`"myapp/db/Database"`). Layers are named `layer`, not
`Default` or `Live`. There is no auto-generated layer in v4.

## Critical Rules

Read [references/critical-rules.md](./references/critical-rules.md) before writing any v4 code. Key guidelines:

- **INEFFECTIVE:** try-catch in `Effect.gen` (Effect failures are not thrown)
- **BROKEN IN V4:** `yield*` or Effect combinators on `Ref`, `Deferred`, `Fiber`, `Option`, or `Result`. They are
  no longer Effects. See the Effect subtyping section below.
- **AVOID:** type assertions (`as never` / `any` / `unknown`)
- **RECOMMENDED:** `return yield*` for errors, and `Effect.fn` over functions returning `Effect.gen`

## Effect Subtyping Removed

The single largest behavioural change from v3. In v3 many types _were_ Effects. In v4 only `Config` values,
`Context.Service` / `Context.Reference` tags, and yieldable errors (`Schema.TaggedError`, `Data.TaggedError`) still
are, so `yield*` and combinators work on them directly. Everything else needs an explicit conversion.

```typescript
const program = Effect.gen(function* () {
  // Option and Result are plain data, not Effects: convert before yielding.
  const value = yield* Effect.fromOption(Option.some(42)); // fails with NoSuchElementError on None
  const n = yield* Effect.fromResult(Result.succeed(1));
  return value + n;
});
```

| v3 (yield the value directly) | v4                                 |
| ----------------------------- | ---------------------------------- |
| `yield* ref`                  | `yield* Ref.get(ref)`              |
| `yield* deferred`             | `yield* Deferred.await(deferred)`  |
| `yield* fiber`                | `yield* Fiber.join(fiber)`         |
| `yield* option`               | `yield* Effect.fromOption(option)` |
| `yield* either`               | `yield* Effect.fromResult(result)` |

`Option.gen` and `Result.gen` give generator syntax over those types without entering Effect. Upstream
`migration/yieldable.md` still shows `yield* Option.some(42)` inside `Effect.gen` and an `.asEffect()` method. Neither
matches the `4.0.0-rc.117` source: `Option` and `Result` have no `asEffect`, and yielding one in `Effect.gen` is a
type error.

## Common Failure Modes

Migrating v3 muscle memory is where most v4 errors come from:

- **`Effect.catchAll` is not a function**: renamed to `Effect.catch`. See
  [references/migration-from-v3.md](./references/migration-from-v3.md).
- **`Effect.fork` is not a function**: renamed to `Effect.forkChild`.
- **`unsafeMake` is not a function**: v4 moved the `unsafe` prefix to a `Unsafe` suffix on the constructors that kept
  one (`Equal.byReferenceUnsafe`, `Duration.fromInputUnsafe`). `SubscriptionRef` has no unsafe/sync constructor at
  all in v4. `SubscriptionRef.make` only returns an `Effect`; use `yield* SubscriptionRef.make(initial)`.
- **`Either` not exported**: renamed to `Result`.
- **Type error passing a `Ref` or `Option` to `Effect.map`**: not an Effect in v4. Use `Ref.get` or
  `Effect.fromOption`.
- **`Effect.Service` not found**: replaced by `Context.Service` with a `make` option, and no auto-generated `.Default`.
- **`@effect/platform` not resolving**: `FileSystem`, `Path`, `Terminal`, and `PlatformError` moved into core `effect`.
- **Layer built twice**: v4 memoizes layers across `Effect.provide` calls. If you _wanted_ two instances, use
  `Layer.fresh` or `Effect.provide(layer, { local: true })`.

## Quick Reference

### Creating Effects

```typescript
Effect.succeed(value); // Wrap success value
Effect.fail(error); // Create failed effect
Effect.sync(fn); // Wrap synchronous non-throwing function
Effect.try(fn); // Wrap synchronous throwing function
Effect.promise(fn); // Wrap non-failing promise
Effect.tryPromise(fn); // Wrap promise-returning function
```

### Composing Effects

```typescript
Effect.flatMap(effect, fn);
Effect.map(effect, fn);
Effect.tap(effect, fn);
Effect.all([...effects], { concurrency: "unbounded" });
Effect.forEach(items, fn, { concurrency: 5 });

// Collect every result instead of short-circuiting (v3 used mode: "validate").
Effect.all([e1, e2, e3], { mode: "result" });

// Returns [failures, successes].
Effect.partition(items, (item) => process(item));
```

### Error Handling

```typescript
Effect.catch(effect, fn); // v3: catchAll
Effect.catchCause(effect, fn); // v3: catchAllCause
Effect.catchDefect(effect, fn); // v3: catchAllDefect
Effect.catchTag(effect, "MyError", fn); // unchanged
Effect.catchTag(effect, ["AError", "BError"], fn); // multiple tags in one call
Effect.catchTags(effect, { AError: fn, BError: fn }); // unchanged
Effect.catchFilter(Filter.fromPredicate(pred), fn); // v3: catchSome
Effect.result(effect); // Effect<Result<A, E>>
Effect.exit(effect); // Effect<Exit<A, E>>
Effect.option(effect); // Effect<Option<A>>
Effect.orElseSucceed(effect, fn); // v3 Effect.orElse is gone, use Effect.catch

// New in v4: handle a tagged `reason` without removing the parent error.
Effect.catchReason(effect, "AiError", "RateLimitError", fn);
Effect.catchReasons(effect, "AiError", { RateLimitError: fn });
```

### Error Taxonomy

| Category                | Examples                   | Handling                   |
| ----------------------- | -------------------------- | -------------------------- |
| **Expected Rejections** | User cancel, deny          | Graceful exit, no retry    |
| **Domain Errors**       | Validation, business rules | Show to user, don't retry  |
| **Defects**             | Bugs, assertions           | Log and alert, investigate |
| **Interruptions**       | Fiber cancel, timeout      | Cleanup, may retry         |
| **Unknown/Foreign**     | Thrown exceptions          | Normalize at boundary      |

`Cause` is flat in v4: `{ reasons: ReadonlyArray<Fail | Die | Interrupt> }`. There is no `Empty`, `Sequential`, or
`Parallel`. Use `Cause.hasFails`, `Cause.hasDies`, `Cause.hasInterrupts`, and iterate `cause.reasons`. All
`*Exception` classes are now `*Error` (`Cause.NoSuchElementError`, `Cause.TimeoutError`, `Cause.UnknownError`).

### Pattern Matching

```typescript
import { Match } from "effect";

const handleError = Match.type<AppError>().pipe(
  Match.tag("UserCancelledError", () => null),
  Match.tag("ValidationError", (e) => e.message),
  Match.exhaustive,
);

Match.value(status).pipe(
  Match.when("pending", () => "Loading..."),
  Match.orElse(() => "Unknown"),
);
```

`Match.tagsExhaustive` and `Match.discriminatorsExhaustive` handle whole objects of cases at once. `Match.either` is
gone; the non-exhaustive finishers are `Match.option` and `Match.result`.

### Services and Layers

```typescript
// Function syntax
const Database = Context.Service<Database>("myapp/Database");

// Class syntax: type params first, identifier second.
class Database extends Context.Service<Database, { query(sql: string): Effect.Effect<void> }>()(
  "myapp/Database",
) {}

// Service with a constructor effect stored on the class.
class Logger extends Context.Service<Logger>()("myapp/Logger", { make: makeLogger }) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Config.layer));
}

// Defaultable service, no layer needed.
const FeatureFlag = Context.Reference<boolean>("myapp/FeatureFlag", { defaultValue: () => false });

Layer.provide(inner, outer); // expose only inner's services
Layer.provideMerge(inner, outer); // expose both
Effect.provide(effect, Logger.layer);
Effect.provide(effect, Logger.layer, { local: true }); // opt out of shared memoization
```

Access a service with `yield*` in a generator. `Service.use` / `Service.useSync` exist but hide the dependency at the
call site, so prefer `yield*`.

### Generator Pattern

```typescript
Effect.gen(function* () {
  const a = yield* effectA;
  if (bad) {
    return yield* new MyError({ message: "bad" });
  }
  return a;
});

// Passing `this` requires an options object in v4.
Effect.gen({ self: this }, function* () {});
```

### Resource Management

```typescript
Effect.acquireRelease(acquire, release); // Scoped resource
Effect.acquireUseRelease(acquire, use, release); // Bracket
Effect.scoped(effect);
Effect.addFinalizer(cleanup);
Scope.provide(scope)(effect); // v3: Scope.extend
```

### Duration and Scheduling

```typescript
Duration.toMillis("5 minutes"); // String inputs still accepted anywhere a Duration.Input is expected
Effect.retry(effect, Schedule.exponential("100 millis"));
Effect.repeat(effect, Schedule.spaced("1 second"));
Schedule.recurs(3);
Schedule.jittered(schedule);
```

### State and Concurrency

```typescript
Ref.make(initial); // then Ref.get / Ref.set / Ref.update
Deferred.make<A, E>(); // then Deferred.await / Deferred.succeed
SubscriptionRef.make(initial); // then SubscriptionRef.get / .set / .changes
Semaphore.make(permits); // now its own module

Effect.forkChild(effect); // v3: fork
Effect.forkDetach(effect); // v3: forkDaemon
Effect.forkScoped(effect);
Effect.forkChild(effect, { startImmediately: true, uninterruptible: "inherit" });
Fiber.join(fiber);
Effect.race(a, b);
```

### Fiber-Local State

`FiberRef` is gone. Built-in fiber-local values are `Context.Reference`s on the `References` module, read with
`yield*` and set with `Effect.provideService`.

```typescript
Effect.gen(function* () {
  const level = yield* References.CurrentLogLevel;
});
Effect.provideService(effect, References.CurrentLogLevel, "Debug"); // v3: Effect.locally
```

### Configuration

```typescript
import { Config, ConfigProvider, Effect, Redacted } from "effect";

// Constructors are PascalCase in v4 (v3: Config.string, Config.number, Config.redacted).
Config.String("HOST").pipe(Config.withDefault("localhost"));
Config.Number("PORT");
Config.Redacted("API_KEY"); // Redacted<string>, unwrap with Redacted.value
Config.all({ host: Config.String("HOST"), port: Config.Number("PORT") }).pipe(
  Config.nested("DATABASE"),
);
Config.schema(MySchema, "KEY"); // validate with Schema (v3 used Config.validate)
Config.mapEffect(config, fn); // v3: Config.mapOrFail
```

### Running Programs

```typescript
Effect.runPromise(effect);
Effect.runSync(effect);
Effect.runFork(effect);
Effect.runForkWith(services)(effect); // v3: Runtime.runFork(runtime)
```

`Runtime<R>` no longer exists; use `Context<R>` via `Effect.context<R>()`. The core runtime now keeps the process
alive on its own, but `runMain` from a platform package is still recommended for signal handling, exit codes, and
error reporting.

### Equality

`Equal.equals` is **structural by default** in v4 for plain objects, arrays, `Map`, `Set`, `Date`, and `RegExp`.
`Equal.equals(NaN, NaN)` is now `true`. Opt out with `Equal.byReference`. `Equal.equivalence` is now
`Equal.asEquivalence`.

## Additional Resources

### Local Effect Resources

- **`$SKILL_DIR/.source/LLMS.md`** and **`$SKILL_DIR/.source/migration/`**: read these first
- **`$SKILL_DIR/.source/packages/effect/src/`**: core modules, with `unstable/` and `testing/` subtrees
- **`$SKILL_DIR/.source/ai-docs/src/`**: runnable examples by topic

### Reference Files

- **[references/critical-rules.md](./references/critical-rules.md)**: forbidden patterns and mandatory conventions
- **[references/migration-from-v3.md](./references/migration-from-v3.md)**: condensed v3 to v4 rename tables
- **[references/services-and-layers.md](./references/services-and-layers.md)**: `Context.Service` and layer composition
- **[references/option-result.md](./references/option-result.md)**: Option, Result, UndefinedOr, and null boundaries
- **[references/streams.md](./references/streams.md)**: v4 Stream patterns and backpressure gotchas
- **[references/testing.md](./references/testing.md)**: `@effect/vitest` v4 deterministic testing
- **[references/effect-atom.md](./references/effect-atom.md)**: Atom reactive state for React
