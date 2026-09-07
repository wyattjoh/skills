# Option, Result, and Null Boundaries in v4

## The Rule

Use `Option<T>` for Effect domain logic. Use `T | null` only at external boundaries.

v4 adds two things that change how this plays out: `Either` was renamed to `Result`, and `Option` is no longer an
`Effect` subtype.

## v3 to v4 Cheatsheet

| v3                          | v4                                                            |
| --------------------------- | ------------------------------------------------------------- |
| `Option.fromNullable(x)`    | `Option.fromNullishOr(x)`                                     |
| `Either`                    | `Result`                                                      |
| `Either.right` / `left`     | `Result.succeed` / `Result.fail`                              |
| `Either.isRight` / `isLeft` | `Result.isSuccess` / `Result.isFailure`                       |
| `Effect.either(effect)`     | `Effect.result(effect)`                                       |
| `Option` usable as Effect   | `Option` is `Yieldable`, needs `.asEffect()` outside `yield*` |

`Option.fromNullable` does not exist in v4. The replacements are explicit about which nullish value they accept:

```typescript
Option.fromNullishOr(x); // null and undefined become None
Option.fromNullOr(x); // only null becomes None; undefined stays a valid Some
Option.fromUndefinedOr(x); // only undefined becomes None; null stays a valid Some
```

## When to Use Option\<T>

- Internal Effect computations
- Domain models where absence has meaning
- Function returns that may not produce a value
- Chained operations that may fail to produce a value

## When to Use T | null

- React state and props (hooks expect nullable primitives)
- JSON serialization (`Option` does not serialize to JSON)
- External API responses
- Database query results
- `localStorage` and `sessionStorage` values

## Boundary Normalization

```typescript
import { Option } from "effect";

// Incoming: nullish to Option, at the API or storage boundary.
const fromApi = Option.fromNullishOr(response.data);
const fromStorage = Option.fromNullishOr(localStorage.getItem("key"));

// Outgoing: Option to nullable, for React or JSON.
const toReact = Option.getOrNull(maybeValue);
const toJson = Option.getOrUndefined(maybeValue);
```

## Common Option Patterns

```typescript
Option.map(maybeUser, (user) => user.name);
Option.flatMap(maybeUser, (user) => Option.fromNullishOr(user.profile));
Option.flatMapNullishOr(maybeUser, (user) => user.profile); // both steps in one
Option.getOrElse(maybeValue, () => defaultValue);
Option.filter(maybeValue, (v) => v.length > 0);
Option.firstSomeOf([a, b, c]);

if (Option.isSome(maybeValue)) {
  console.log(maybeValue.value); // Safe access
}

Option.match(maybeValue, {
  onNone: () => "nothing",
  onSome: (v) => `got ${v}`,
});
```

## Option Is Yieldable, Not an Effect

In a generator, `yield*` on an `Option` produces the value or fails with `Cause.NoSuchElementError`:

```typescript
const program = Effect.gen(function* () {
  const value = yield* Option.some(42); // Effect<number, NoSuchElementError>
  return value;
});
```

Anywhere else, convert explicitly:

```typescript
// Type error in v4: Option is not an Effect.
Effect.map(Option.some(42), (n) => n + 1);

// Correct.
Effect.map(Option.some(42).asEffect(), (n) => n + 1);
```

## Result Replaces Either

`Result<A, E>` carries a success or a failure. It is also `Yieldable`.

```typescript
import { Result } from "effect";

Result.succeed(value);
Result.fail(error);

Result.isSuccess(result);
Result.isFailure(result);
Result.getSuccess(result); // Option<A>
Result.getFailure(result); // Option<E>

Result.match(result, {
  onFailure: (e) => `failed: ${e}`,
  onSuccess: (a) => `ok: ${a}`,
});

Result.map(result, fn);
Result.mapError(result, fn);
Result.mapBoth(result, { onFailure, onSuccess });
Result.getOrElse(result, () => fallback);
Result.fromOption(option, () => new NotFoundError());
Result.transposeOption(optionOfResult);
```

`Effect.result(effect)` produces `Effect<Result<A, E>>`, replacing v3's `Effect.either`. Use `Effect.exit` when an
`Exit` is wanted instead, and `Effect.option` for `Effect<Option<A>>`.

Parts of `Cause` return `Result` in v4: `Cause.findError`, `Cause.findDefect`, `Cause.findInterrupt`, and
`Cause.filterInterruptors`. The `Option` variant is `Cause.findErrorOption`.

## UndefinedOr

v4 adds a small `UndefinedOr` module for working with `T | undefined` directly, without wrapping in `Option`. It is
useful at boundaries where an `Option` allocation is not worth it:

```typescript
import { UndefinedOr } from "effect";

UndefinedOr.map(maybe, (v) => v + 1);
UndefinedOr.match(maybe, { onUndefined: () => 0, onDefined: (v) => v });
UndefinedOr.getOrThrow(maybe);
```

Keep it at boundaries. `Option` remains the domain representation.

## Filter Replaces Option-Returning Predicates

Several v4 combinators that took a function returning `Option` now take a `Filter`:

```typescript
import { Filter } from "effect";

Effect.catchFilter(
  Filter.fromPredicate((e: number) => e === 42),
  (e) => Effect.succeed("caught"),
);
```

`Filter` also builds from tags and types (`Filter.tagged`, `Filter.instanceOf`, `Filter.string`, `Filter.number`),
composes (`Filter.and`, `Filter.or`, `Filter.compose`), and converts with `Filter.toOption` and `Filter.toResult`.

## Avoid Option\<Option\<T>> Creep

```typescript
// Wrong: nested options from repeated normalization.
const bad = Option.fromNullishOr(Option.fromNullishOr(x));

// Right: normalize once at the boundary.
const good = Option.fromNullishOr(x);

// If you already have nested options, flatten.
const flattened = Option.flatten(nestedOption);
```

## Schema Decoding

```typescript
import { Schema } from "effect";

const User = Schema.Struct({
  name: Schema.String,
  // Optional property key; absent decodes to a missing key.
  nickname: Schema.optionalKey(Schema.String),
  // Decodes into Option<string>.
  avatar: Schema.Option(Schema.String),
});

const ApiUser = Schema.Struct({
  name: Schema.String,
  nickname: Schema.NullOr(Schema.String), // string | null
  avatar: Schema.NullishOr(Schema.String), // string | null | undefined
});
```

`Schema.optional`, `Schema.optionalKey`, `Schema.NullOr`, `Schema.UndefinedOr`, and `Schema.NullishOr` cover the
combinations. v3's `Schema.optionalWith(..., { as: "Option" })` is replaced by wrapping with `Schema.Option`.

## Atom Integration

Effectful atoms surface a `Result`, so React components pattern match on it rather than on `Option`:

```typescript
const userResult = useAtomValue(userAtom); // Result<User, FetchError>

Result.match(userResult, {
  onSuccess: (user) => user.name,
  onFailure: (error) => String(error),
});
```

Convert `Option` to null at the component boundary:

```typescript
const program = Effect.gen(function* () {
  const maybeUser = yield* fetchUser(); // Option<User>
  return Option.getOrNull(maybeUser); // User | null, for React
});
```
