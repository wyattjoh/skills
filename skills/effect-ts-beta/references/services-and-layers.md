# Services and Layers in Effect v4

v4 replaces `Context.Tag`, `Context.GenericTag`, `Effect.Tag`, and `Effect.Service` with a single `Context.Service`.
Layers are always built explicitly.

## Defining a Service

The canonical form: type parameters first, identifier string second, layer attached as a static.

```typescript
// file: src/db/Database.ts
import { Context, Effect, Layer, Schema } from "effect";

export class Database extends Context.Service<
  Database,
  {
    query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>;
  }
>()(
  // Identifier includes the package name and the path to the service file.
  "myapp/db/Database",
) {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const query = Effect.fn("Database.query")(function* (sql: string) {
        yield* Effect.log("Executing SQL query:", sql);
        return [{ id: 1, name: "Alice" }];
      });

      // Construct the instance with `.of` so the shape is checked.
      return Database.of({ query });
    }),
  );
}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {}

// Recover the service shape type when needed.
export type DatabaseService = Database["Service"];
```

A function form exists for services that do not need a class:

```typescript
const Database = Context.Service<Database>("myapp/db/Database");
```

### Argument Order

This is the most common mistake when porting from v3:

```typescript
// v3: identifier first, then type parameters.
class Database extends Context.Tag("Database")<Database, Shape>() {}

// v4: type parameters first, then identifier.
class Database extends Context.Service<Database, Shape>()("myapp/db/Database") {}
```

### Naming Conventions

- Identifier strings are namespaced paths: `"myapp/db/Database"`, not `"Database"`.
- The primary layer is `layer`, not `Default` or `Live`.
- Variants take descriptive suffixes: `layerTest`, `layerConfig`, `layerNoDeps`.

## Services With a `make` Effect

`Context.Service` accepts a `make` option that stores a constructor effect on the class. Unlike v3's
`Effect.Service`, this does **not** generate a layer, and there is no `dependencies` option.

```typescript
class Logger extends Context.Service<Logger>()("myapp/Logger", {
  make: Effect.gen(function* () {
    const config = yield* Config;
    return { log: (msg: string) => Effect.log(`[${config.prefix}] ${msg}`) };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Config.layer));
}
```

## Accessing a Service

Prefer `yield*` in a generator. It keeps the dependency visible in the effect's `R` channel at the call site.

```typescript
const program = Effect.gen(function* () {
  const notifications = yield* Notifications;
  yield* notifications.notify("hello");
  yield* notifications.notify("world");
});
```

`use` and `useSync` are available as one-liners. They return an `Effect` requiring the service, but the dependency is
easy to leak into a return value unnoticed, so reach for them sparingly.

```typescript
// Effect<void, never, Notifications>
Notifications.use((n) => n.notify("hello"));

// Effect<number, never, Config>, for a synchronous accessor
Config.useSync((c) => c.port);
```

The v3 static accessor proxy (`Notifications.notify("hello")`) was removed. It erased generic type parameters and
overloads, collapsing `get<T>(key: string): Effect<T>` into `get(key: string): Effect<unknown>`.

## References: Services With Defaults

`Context.Reference` defines a value that has a default, so no layer is required. This is also how fiber-local state
works in v4, replacing `FiberRef`.

```typescript
export const FeatureFlag = Context.Reference<boolean>("myapp/FeatureFlag", {
  defaultValue: () => false,
});

// Read
const enabled = yield * FeatureFlag;

// Override for the duration of an effect
Effect.provideService(program, FeatureFlag, true);
```

Note the v3 to v4 signature change: `Context.Reference<Self>()(id, opts)` became `Context.Reference<T>(id, opts)`.

## Composing Layers

`Layer.provide` satisfies a layer's requirements and exposes only the outer service. `Layer.provideMerge` exposes
both.

```typescript
export class UserRepository extends Context.Service<
  UserRepository,
  {
    findById(id: string): Effect.Effect<Option.Option<User>, UserRepositoryError>;
  }
>()("myapp/UserRepository") {
  // Layer that still requires SqlClient.
  static readonly layerNoDeps: Layer.Layer<UserRepository, never, SqlClient.SqlClient> =
    Layer.effect(
      UserRepository,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const findById = Effect.fn("UserRepository.findById")(
          function* (id: string) {
            const results = yield* sql<User>`SELECT * FROM users WHERE id = ${id}`;
            return Array.head(results);
          },
          Effect.mapError((reason) => new UserRepositoryError({ reason })),
        );

        return UserRepository.of({ findById });
      }),
    );

  // Exposes only UserRepository.
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(SqlClientLayer));

  // Exposes UserRepository and SqlClient.
  static readonly layerWithSqlClient = this.layerNoDeps.pipe(Layer.provideMerge(SqlClientLayer));
}
```

Splitting the dependency-free layer (`layerNoDeps`) from the wired one is the upstream pattern. It lets tests supply
substitutes without rebuilding the service definition.

Other useful constructors:

- `Layer.succeed(Tag, value)` for a constant implementation
- `Layer.effectDiscard(effect)` for background work with no service interface
- `Layer.unwrap(effectOrConfig)` to build a layer dynamically from an Effect or Config
- `Layer.launch(layer)` as a long-running application entrypoint
- `LayerMap.Service` for resources keyed by an identifier, such as a tenant ID

## Memoization Changed in v4

In v3, each `Effect.provide` call had its own memo map, so providing the same layer twice built it twice. In v4 the
memo map is shared across `provide` calls on a fiber, so it is built once.

```typescript
const main = program.pipe(Effect.provide(MyServiceLayer), Effect.provide(MyServiceLayer));
// v3: builds twice. v4: builds once.
```

Compose layers and provide once anyway. The shared memo map is a safety net against the v3 footgun, not a substitute
for an explicit dependency graph.

Opt out when independent instances are genuinely wanted, such as isolated test resources or separate pools:

```typescript
Effect.provide(effect, Layer.fresh(MyServiceLayer)); // bypass the shared cache
Effect.provide(effect, MyServiceLayer, { local: true }); // build the subtree in a local memo map
```

## Providing Context Directly

```typescript
Effect.provideService(effect, Logger, { log: console.log });
Effect.provideContext(effect, Context.make(Logger, { log: console.log }));

// Read the whole context, for example to run a nested program.
const services = yield * Effect.context<Logger>();
Effect.runForkWith(services)(program);
```

## Resources in Layers

```typescript
const layer = Layer.effect(
  Connection,
  Effect.acquireRelease(openConnection, (conn) => Effect.sync(() => conn.close())),
);
```

Layers are scoped, so `acquireRelease` finalizers run when the layer's scope closes. Use `Layer.effectDiscard` for
background tasks that expose no service.
