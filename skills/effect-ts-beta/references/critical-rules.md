# Critical Rules for Effect v4

These rules address common mistakes when working with Effect v4. The first two are v4-specific and account for most
errors when carrying v3 habits forward.

## BROKEN IN V4: Treating Yieldable Values as Effects

In v3, `Ref`, `Deferred`, `Fiber`, `Option`, `Result`, `Config`, and service tags were structural subtypes of
`Effect`. In v4 they implement the narrower `Yieldable` trait: `yield*` works, assignment to `Effect` does not.

**Problematic:**

```typescript
// Type error in v4: Ref is not an Effect.
const value = yield * ref;
const doubled = Effect.map(ref, (n) => n * 2);
const results = yield * Effect.all([refA, refB]);
```

**Correct:**

```typescript
const value = yield * Ref.get(ref);
const doubled = Effect.map(Ref.get(ref), (n) => n * 2);
const results = yield * Effect.all([Ref.get(refA), Ref.get(refB)]);
```

For types that are still `Yieldable` (`Option`, `Result`, `Config`), `yield*` is fine, but combinators need an
explicit `.asEffect()`:

```typescript
Effect.map(Option.some(42).asEffect(), (n) => n + 1);

// Usually clearer as a generator:
Effect.gen(function* () {
  const n = yield* Option.some(42);
  return n + 1;
});
```

Why this changed: in v3 the type system could not distinguish "I have a `Ref`" from "I have an `Effect` that reads
the `Ref`", so passing a `Ref` where the value was meant silently compiled.

## AVOID: v3 Names That Still Read as Valid

These fail at runtime or type-check time, and the error messages rarely point at the rename:

| v3                           | v4                                       |
| ---------------------------- | ---------------------------------------- |
| `Effect.catchAll`            | `Effect.catch`                           |
| `Effect.catchAllCause`       | `Effect.catchCause`                      |
| `Effect.catchAllDefect`      | `Effect.catchDefect`                     |
| `Effect.catchSome`           | `Effect.catchFilter`                     |
| `Effect.fork`                | `Effect.forkChild`                       |
| `Effect.forkDaemon`          | `Effect.forkDetach`                      |
| `Effect.locally`             | `Effect.provideService` with a Reference |
| `Effect.Service`             | `Context.Service` with `make`            |
| `Context.Tag`                | `Context.Service`                        |
| `Either`                     | `Result`                                 |
| `FiberRef.*`                 | `References.*`                           |
| `Scope.extend`               | `Scope.provide`                          |
| `SubscriptionRef.unsafeMake` | `SubscriptionRef.makeUnsafe`             |

The `unsafe` prefix was moved to a `Unsafe` suffix throughout v4. There are zero `unsafe*` exports left in the core
package, so any `unsafeX` call is a v3 leftover.

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

## Layer Memoization Is Now Shared

v4 shares the memo map across `Effect.provide` calls, so a layer provided twice is built once. This fixes a v3
footgun, but it also means tests that relied on a fresh build per `provide` now share state.

When independent instances are genuinely needed:

```typescript
Effect.provide(effect, Layer.fresh(MyLayer));
Effect.provide(effect, MyLayer, { local: true });
```

Composing layers once and providing once is still the recommended structure. Auto-memoization is a safety net, not a
substitute for an explicit dependency graph.

## Beta Stability

`4.0.0-beta.107` is a prerelease and APIs move between betas. Two consequences:

- Verify a symbol against the pinned source before recommending it, rather than recalling it.
- Modules under `effect/unstable/*` may break in minor releases even after v4 is stable. Treat them as provisional
  and expect to update imports when they graduate to the top-level namespace.
