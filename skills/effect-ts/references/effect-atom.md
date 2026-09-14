# Effect-Atom Reference

Reactive state management library for Effect. Provides atoms (reactive state containers) that integrate with Effect's
functional programming ecosystem and React.

**Source code:** https://github.com/tim-smart/effect-atom (open in browser)

## Core API

### Creating Atoms

```typescript
import { Atom } from "@effect-atom/atom-react";

// Simple value atom
const countAtom = Atom.make(0);

// Derived atom (computed from other atoms)
const doubleAtom = Atom.make((get) => get(countAtom) * 2);

// Effectful atom (returns Result type)
const userAtom = Atom.make(
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.fetchUser();
  }),
);

// Keep value when component unmounts (prevents reset)
const persistentAtom = Atom.make(0).pipe(Atom.keepAlive);
```

### React Hooks

```typescript
import { useAtomValue, useAtomSet, useAtom } from "@effect-atom/atom-react"

function Counter() {
  // Read-only access
  const count = useAtomValue(countAtom)

  // Write-only access
  const setCount = useAtomSet(countAtom)

  // Read and write access
  const [value, setValue] = useAtom(countAtom)

  return <button onClick={() => setCount((n) => n + 1)}>{count}</button>
}
```

### Atom Families

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

// Usage
const userAtom = userAtomFamily("user-123");
```

### Atom Functions

Create callable effects:

```typescript
const incrementFn = Atom.fn(
  Effect.gen(function* () {
    const count = yield* Ref.get(counterRef);
    yield* Ref.set(counterRef, count + 1);
  }),
);

// Invoke with useAtomSet
const increment = useAtomSet(incrementFn);
increment(); // Fire-and-forget by default; pass { mode: "promiseExit" } to await a Promise<Exit<...>>
```

### Atom Runtime

Build a runtime atom from Effect layers for dependency injection, then derive
atoms from it directly — there is no separate provider component:

```typescript
const runtimeAtom = Atom.runtime(ApiLive);

const usersAtom = runtimeAtom.atom(
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.fetchUsers();
  }),
);
```

Wrap the app in `RegistryProvider` only when a non-default registry
configuration is needed (`initialValues`, `scheduleTask`, `timeoutResolution`,
`defaultIdleTTL`); it takes no `runtime` prop.

## Advanced Features

### URL Search Parameters

Bind atoms to URL search parameters. Without a `schema` option the atom's value
is the raw string; pass a synchronous, context-free `Schema` to decode/encode it:

```typescript
import { Schema } from "effect";

const pageAtom = Atom.searchParam("page", {
  schema: Schema.NumberFromString,
});
```

Source: `@effect-atom/atom` `Atom.d.ts` (`searchParam` accepts `{ schema? }`, not `decode`/`encode`).

### Local Storage Persistence

`Atom.kvs` needs a `runtime` built from a `KeyValueStore` layer and a `Schema` for
the stored value; `defaultValue` is a thunk, not a bare value:

```typescript
import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Schema } from "effect";

const kvsRuntime = Atom.runtime(BrowserKeyValueStore.layerLocalStorage);

const settingsAtom = Atom.kvs({
  runtime: kvsRuntime,
  key: "app-settings",
  schema: Schema.Struct({ theme: Schema.String }),
  defaultValue: () => ({ theme: "dark" }),
});
```

Source: https://github.com/tim-smart/effect-atom (README, "Integration with local storage").

### Scoped Resources

Add finalizers for cleanup when atom rebuilds or unmounts:

```typescript
const websocketAtom = Atom.make((get) =>
  Effect.gen(function* () {
    const ws = yield* WebSocket.connect("wss://...");
    yield* Effect.addFinalizer(() => ws.close());
    return ws;
  }),
);
```

### Event Listeners with Self-Update

```typescript
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

### Reactivity Keys

Trigger cache invalidation:

```typescript
const dataAtom = Atom.make(
  Effect.gen(function* () {
    const keys = yield* Atom.withReactivity(["data-key"]);
    // Re-runs when "data-key" is invalidated
    return yield* fetchData();
  }),
);
```

### RPC and HTTP API Integration

```typescript
// RPC client
const rpcClient = AtomRpc.Tag();

// HTTP API client
const httpClient = AtomHttpApi.Tag();
```

## Result Handling

Effectful atoms return `Result` types. Handle with pattern matching; `Result.match`
requires all three branches, including `onInitial` (before the effect has run):

```typescript
function UserProfile() {
  const userResult = useAtomValue(userAtom)

  return Result.match(userResult, {
    onInitial: () => <div>Loading...</div>,
    onSuccess: (result) => <div>{result.value.name}</div>,
    onFailure: (result) => <div>Error: {String(result.cause)}</div>,
  })
}
```

### Mutation Results

Use `mode: "promiseExit"` for mutation handling:

```typescript
const saveUser = useAtomSet(saveUserAtom, { mode: "promiseExit" });

const handleSave = async () => {
  const exit = await saveUser(userData);
  if (Exit.isSuccess(exit)) {
    // Handle success
  }
};
```

## Streams

Pull values from streams:

```typescript
const messagesAtom = Atom.pull(messageStream);
```

## Best Practices

1. **Use `Atom.family` for dynamic keys** — Generates stable references, avoids memory leaks
2. **Apply `Atom.keepAlive` for persistent state** — Prevents reset on unmount
3. **Use `Atom.runtime` for dependency injection** — Integrates Effect layers with React context
4. **Implement finalizers for cleanup** — Ensures proper resource management
5. **Use `mode: "promiseExit"` for mutations** — Provides typed success/failure handling
6. **Prefer derived atoms over component state** — Keeps state logic centralized
