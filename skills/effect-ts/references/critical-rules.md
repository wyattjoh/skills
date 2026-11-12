# Critical Rules for Effect v4

These rules address common mistakes when working with Effect v4. The first two are v4-specific and account for most
errors when carrying v3 habits forward.

## BROKEN IN V4: Treating Former Effect Subtypes as Effects

In v3, `Ref`, `Deferred`, `Fiber`, `Option`, `Either`, `Config`, and service tags were structural subtypes of
`Effect`. In v4 only `Config`, service tags (`Context.Service`, `Context.Reference`), and yieldable errors still
extend `Effect`. `Ref`, `Deferred`, `Fiber`, `Option`, and `Result` are plain values: neither `yield*` nor Effect
combinators accept them.

**Problematic:**

```typescript
Effect.gen(function* () {
  // Type error in v4: Ref is not an Effect.
  const value = yield* ref;
  const doubled = Effect.map(ref, (n) => n * 2);
  const results = yield* Effect.all([refA, refB]);
});
```

**Correct:**

```typescript
Effect.gen(function* () {
  const value = yield* Ref.get(ref);
  const doubled = Effect.map(Ref.get(ref), (n) => n * 2);
  const results = yield* Effect.all([Ref.get(refA), Ref.get(refB)]);
});
```

`Option` and `Result` convert with `Effect.fromOption` and `Effect.fromResult`. There is no `.asEffect()` method on
them, whatever older prerelease copies of upstream `migration/yieldable.md` showed:

```typescript
Effect.map(Effect.fromOption(Option.some(42)), (n) => n + 1);

// Usually clearer as a generator:
Effect.gen(function* () {
  const n = yield* Effect.fromOption(Option.some(42));
  return n + 1;
});
```

Why this changed: in v3 the type system could not distinguish "I have a `Ref`" from "I have an `Effect` that reads
the `Ref`", so passing a `Ref` where the value was meant silently compiled.

## AVOID: v3 Names That Still Read as Valid

These fail at runtime or type-check time, and the error messages rarely point at the rename:

| v3                      | v4                                       |
| ----------------------- | ---------------------------------------- |
| `Effect.catchAll`       | `Effect.catch`                           |
| `Effect.catchAllCause`  | `Effect.catchCause`                      |
| `Effect.catchAllDefect` | `Effect.catchDefect`                     |
| `Effect.catchSome`      | `Effect.catchFilter`                     |
| `Effect.orElse`         | `Effect.catch`                           |
| `Effect.fork`           | `Effect.forkChild`                       |
| `Effect.forkDaemon`     | `Effect.forkDetach`                      |
| `Effect.locally`        | `Effect.provideService` with a Reference |
| `Effect.Service`        | `Context.Service` with `make`            |
| `Context.Tag`           | `Context.Service`                        |
| `Either`                | `Result`                                 |
| `FiberRef.*`            | `References.*`                           |
| `Scope.extend`          | `Scope.provide`                          |
| `Config.string` etc.    | `Config.String` etc. (PascalCase)        |
| `Config.mapOrFail`      | `Config.mapEffect`                       |

The `unsafe` prefix was moved to a `Unsafe` suffix on the constructors that kept one (`Equal.byReferenceUnsafe`,
`Duration.fromInputUnsafe`), so any `unsafeX` call is a v3 leftover. `SubscriptionRef` is the exception, not an
example of the rename: v4's `SubscriptionRef` has no unsafe or synchronous constructor at all, so
`SubscriptionRef.unsafeMake` has no v4 replacement. Always use `yield* SubscriptionRef.make(initial)`.

## INEFFECTIVE: try-catch in Effect.gen

**Avoid `try-catch` blocks inside `Effect.gen` generators for handling Effect failures.**

Effect failures are returned as exits, not thrown as JavaScript exceptions. try-catch only catches synchronous
throws from non-Effect code.

**Problematic:**

```typescript
Effect.gen(function* () {
  try {
    const result = yield* someEffect;
  } catch (error) {
    // Catches synchronous throws only. Effect failures bypass this entirely.
  }
});
```

**Correct:**

```typescript
Effect.gen(function* () {
  const result = yield* Effect.result(someEffect);
  if (result._tag === "Failure") {
    // Handle error case
  }
});
```

Note that in v4 `Effect.result` produces a `Result`, not an `Exit`. Use `Effect.exit` when an `Exit` is wanted.

Alternative patterns:

- `Effect.catch` / `Effect.catchTag` for error recovery
- `Effect.result` to inspect success/failure
- `Effect.tryPromise` / `Effect.try` for wrapping external code

## AVOID: Functions That Return `Effect.gen`

Use `Effect.fn` for any named function returning an Effect. It names the tracing span, improves stack traces, and
captures the call site.

**Problematic:**

```typescript
const fetchUser = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.query(id);
  });
```

**Correct:**

```typescript
const fetchUser = Effect.fn("fetchUser")(function* (id: string) {
  const db = yield* Database;
  return yield* db.query(id);
});
```

Attach extra behaviour by passing further arguments to `Effect.fn`, **not** by piping its result:

```typescript
const fetchUser = Effect.fn("fetchUser")(
  function* (id: string) {
    /* ... */
  },
  Effect.catch((error) => Effect.logError(error)),
  Effect.annotateLogs({ method: "fetchUser" }),
);
```

Use `Effect.fnUntraced` when the span is genuinely unwanted.

## PREFER: `Schema.TaggedError` over `Data.TaggedError`

Both exist in v4. `Schema.TaggedError` validates its payload, serializes across RPC and cluster boundaries, and is
the form used throughout the upstream docs. Use `Schema.Defect()` for a field carrying an unknown cause.

```typescript
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}
```

## AVOID: Hand-Rolled Validation and Type Guards

Decode untrusted input with `Schema`, never with manual parsing or ad-hoc predicates. For guards on values that are
already typed, use the `Predicate` module rather than writing your own `isRecord` or `isString`:

```typescript
import { Predicate } from "effect";

if (Predicate.isObject(thing) && Predicate.isNumber(thing.a)) {
  console.log(thing.a);
}
```

Predicates compose with `Predicate.and`, `Predicate.or`, `Predicate.not`, and `Predicate.compose`.

## AVOID: Type Assertions

**Avoid `as never`, `as any`, or `as unknown` type assertions.** They break type safety and hide real errors.

**Correct approach:**

- Use proper generic type parameters
- Import correct types from `effect`
- Use proper Effect constructors and combinators
- Adjust function signatures to match usage

Occasional assertions may be justified when interfacing with poorly-typed external libraries. Document the reason.

## RECOMMENDED: return `yield*` for Errors

The runtime halts on failed yields regardless of `return`, but the explicit `return` makes termination obvious and
prevents unreachable-code warnings.

```typescript
Effect.gen(function* () {
  if (someCondition) {
    return yield* new MyError({ message: "bad input" });
  }

  if (shouldInterrupt) {
    return yield* Effect.interrupt;
  }

  return yield* someOtherEffect;
});
```

## Layer Memoization Across `Effect.provide`

In v4 a nested `Effect.provide` reuses any layer an enclosing `provide` (or runtime) already built, so the same layer
provided at two nesting levels is built once. Each `provide` forks the ambient memo map without writing back to it,
so sibling `provide` calls still build their own copies, as in v3. Code that relied on a fresh build in a nested
`provide` now shares the outer instance.

When independent instances are genuinely needed:

```typescript
Effect.provide(effect, Layer.fresh(MyLayer));
Effect.provide(effect, MyLayer, { local: true });
```

Composing layers once and providing once is still the recommended structure. Reuse across nested provides is a
safety net, not a substitute for an explicit dependency graph. See upstream `migration/layer-memoization.md`.

## Stability Tiers

v4 is stable, but not every module follows strict semver. Every module and directly importable export declares its
stability in its API docs:

- `@stability stable` (and untagged APIs) follow strict semver.
- `@stability unstable` (for example `effect/http`, `effect/cli`, `effect/ai`, `effect/reactivity`) may gain features
  in patch releases and break in minor releases. Modules in packages other than `effect` (such as `@effect/vitest`
  and `@effect/atom-react`) are currently all unstable.
- `@stability experimental` may break across patch releases.

Verify a symbol against the pinned source before recommending it, rather than recalling it. Prerelease builds
imported these modules from `effect/unstable/*`; that segment is gone with no compatibility exports, so rewrite any
`effect/unstable/...` import by dropping it.
