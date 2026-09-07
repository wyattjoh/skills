# Atom Reactive State in Effect v4

Reactive state containers that integrate with Effect and React.

## What Changed From v3

In v3 this was a third-party package (`@effect-atom/atom-react`, from https://github.com/tim-smart/effect-atom). In
v4 the core moved into the Effect monorepo:

| v3                                | v4                                |
| --------------------------------- | --------------------------------- |
| `@effect-atom/atom` (`Atom`)      | `effect/unstable/reactivity/Atom` |
| `@effect-atom/atom-react` (hooks) | `@effect/atom-react`              |

`Atom` itself comes from core; `@effect/atom-react` provides only the React bindings (hooks, registry context,
hydration). Solid and Vue bindings ship as `@effect/atom-solid` and `@effect/atom-vue`.

Two constraints:

- `Atom` lives under `effect/unstable/*`, so it may break in minor releases.
- `@effect/atom-react` requires React `>=19.2.7 <20`.

```typescript
import { Atom } from "effect/unstable/reactivity";
import { useAtom, useAtomValue, useAtomSet } from "@effect/atom-react";
```

## Creating Atoms

```typescript
// Simple value atom
const countAtom = Atom.make(0);

// Derived atom, computed from other atoms
const doubleAtom = Atom.make((get) => get(countAtom) * 2);

// Effectful atom, surfaces a Result
const userAtom = Atom.make(
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.fetchUser();
  }),
);

// Keep the value when the last component unmounts
const persistentAtom = Atom.make(0).pipe(Atom.keepAlive);
```

## React Hooks

```typescript
function Counter() {
  const count = useAtomValue(countAtom); // read
  const setCount = useAtomSet(countAtom); // write
  const [value, setValue] = useAtom(countAtom); // both

  return <button onClick={() => setCount((n) => n + 1)}>{count}</button>;
}
```

Also available: `useAtomRefresh`, `useAtomMount`, `useAtomSubscribe`, `useAtomSuspense`, `useAtomInitialValues`,
`useAtomRef`, `useAtomRefProp`, `useAtomRefPropValue`.

## Atom Families

Generate stable atom references for dynamic keys:

```typescript
const userAtomFamily = Atom.family((userId: string) =>
  Atom.make(
    Effect.gen(function* () {
      const api = yield* Api;
      return yield* api.fetchUser(userId);
    }),
  ),
);

const userAtom = userAtomFamily("user-123");
```

## Atom Functions

Create callable effects:

```typescript
const incrementFn = Atom.fn(
  Effect.gen(function* () {
    const count = yield* Ref.get(counterRef);
    yield* Ref.set(counterRef, count + 1);
  }),
);

const increment = useAtomSet(incrementFn);
increment(); // fire-and-forget by default
```

`Atom.fnSync` is the synchronous variant. `Atom.optimisticFn` applies an optimistic update before the effect settles.

## Atom Runtime

Build a runtime atom from Effect layers for dependency injection, then derive atoms from it directly. There is no
separate provider component:

```typescript
const runtimeAtom = Atom.runtime(ApiLayer);

const usersAtom = runtimeAtom.atom(
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.fetchUsers();
  }),
);
```

Wrap the app in `RegistryProvider` only when a non-default registry configuration is needed. It takes no `runtime`
prop.

## Result Handling

Effectful atoms surface a `Result`. Note this is v4's `Result` (v3's `Either` renamed), the same type
`Effect.result` produces.

```typescript
function UserProfile() {
  const userResult = useAtomValue(userAtom);

  return Result.match(userResult, {
    onSuccess: (user) => <div>{user.name}</div>,
    onFailure: (error) => <div>Error: {String(error)}</div>,
  });
}
```

For mutations, await a typed outcome:

```typescript
const saveUser = useAtomSet(saveUserAtom, { mode: "promiseExit" });

const handleSave = async () => {
  const exit = await saveUser(userData);
  if (Exit.isSuccess(exit)) {
    // Handle success
  }
};
```

## Persistence and URL State

```typescript
// Bind to a URL search parameter
const pageAtom = Atom.searchParam("page", {
  decode: (s) => parseInt(s ?? "1", 10),
  encode: (n) => n.toString(),
});

// Persist to key-value storage
const settingsAtom = Atom.kvs({
  key: "app-settings",
  defaultValue: { theme: "dark" },
});
```

`Atom.serializable` and the `Hydration` exports from `@effect/atom-react` cover server-rendered hydration.

## Scoped Resources and Self-Update

```typescript
const websocketAtom = Atom.make((get) =>
  Effect.gen(function* () {
    const ws = yield* connect("wss://...");
    yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()));
    return ws;
  }),
);

const windowSizeAtom = Atom.make((get) =>
  Effect.gen(function* () {
    const handler = () => get.setSelf({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", handler);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => window.removeEventListener("resize", handler)),
    );
    return { width: window.innerWidth, height: window.innerHeight };
  }),
);
```

## Cache Invalidation

```typescript
const dataAtom = Atom.make(
  Effect.gen(function* () {
    yield* Atom.withReactivity(["data-key"]);
    return yield* fetchData();
  }),
);
```

Related: `Atom.refresh`, `Atom.withRefresh`, `Atom.refreshOnWindowFocus`, `Atom.makeRefreshOnSignal`, `Atom.swr`.

## Streams and Subscriptions

```typescript
Atom.pull(messageStream); // pull values from a Stream
Atom.subscriptionRef(ref); // track a SubscriptionRef
Atom.toStream(atom); // observe an atom as a Stream
```

## RPC and HTTP API Integration

The client integrations live under the same unstable namespace:

```typescript
import { AtomRpc } from "effect/unstable/reactivity";
import { AtomHttpApi } from "effect/unstable/reactivity";
```

## Best Practices

1. **Use `Atom.family` for dynamic keys.** Generates stable references and avoids leaks.
2. **Apply `Atom.keepAlive` for state that must survive unmount.**
3. **Use `Atom.runtime` for dependency injection.** It bridges Effect layers into the atom graph.
4. **Register finalizers for anything with a lifecycle.** Atoms rebuild and unmount.
5. **Use `mode: "promiseExit"` for mutations.** Gives typed success and failure handling.
6. **Prefer derived atoms over component state.** Keeps state logic centralized.
7. **Pin the version.** `Atom` is unstable in v4; expect import paths to move when reactivity graduates to the
   top-level namespace.
