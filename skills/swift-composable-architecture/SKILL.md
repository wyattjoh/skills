---
name: swift-composable-architecture
description: >-
  Index for adopting The Composable Architecture (TCA, swift-composable-architecture 1.26.0)
  in a SwiftUI app. Use this whenever implementing or reviewing a feature in TCA, or whenever the
  task touches reducers, `@Reducer`/`@ObservableState`, `Store`/`StoreOf`, scoping, `@Dependency`,
  effects, bindings, navigation (sheets/alerts/`@Presents`/`NavigationStack`/`StackState`),
  `@Shared` state, or `TestStore` tests, even when the prompt does not say "TCA" by name. Each topic
  points at the authoritative TCA 1.26.0 example and a copied real-world example from a production
  reference app, so you can jump from "I need navigation / a dependency / an effect / a testable
  reducer" to a concrete, current pattern. Requires the swift-composable-architecture source vendored
  as a reference submodule (see the prerequisite check below).
---

# Adopting The Composable Architecture (TCA 1.26.0)

## Prerequisite: the TCA source must be vendored

This skill depends on the **swift-composable-architecture source being available locally** as a
reference submodule. Nearly every topic below points at an exact path inside
`.claude/references/swift-composable-architecture/`, pinned to tag **1.26.0**, and those paths only
resolve if the submodule has been vendored. (The copied `examples/reference-app/` files are
self-contained and work regardless; it is only the authoritative TCA paths that need the source.)

If it is missing, vendor it with the **`reference-submodules`** skill (the `/reference-submodules`
slash command): add [`pointfreeco/swift-composable-architecture`](https://github.com/pointfreeco/swift-composable-architecture)
as a reference repo pinned to tag **1.26.0**. That skill clones it under `.claude/references/` and
records it in the project's "Dependency References" table.

**Live check (runs when this skill loads):**

!`d=.claude/references/swift-composable-architecture; if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then echo "✅ TCA 1.26.0 source PRESENT at $d/ — the referenced paths below resolve; read them directly."; else echo "⚠️  TCA source MISSING — the paths below under $d/ do not exist yet. Vendor it first with the reference-submodules skill (/reference-submodules): add pointfreeco/swift-composable-architecture pinned to tag 1.26.0."; fi`

This skill is an **adoption index**, not an API reference. For each TCA concept you pair:

1. **The authoritative TCA 1.26.0 example** — an exact path into the vendored submodule at
   `.claude/references/swift-composable-architecture/` (pinned to tag **1.26.0**). Read it to
   confirm the current API shape.
2. **A real-world example from a reference app** — a production app that uses TCA heavily. The
   relevant snippets are **copied into `examples/reference-app/`** (domain renamed to a neutral
   "notes" example) so this skill is fully self-contained.

## How to use this index

When you start a feature, find the topic that matches what you need, read the authoritative TCA path
to confirm the 1.26.0 API, then skim the copied reference-app example for a real-world shape. Keep
the example files in `examples/reference-app/` open as you write; they are trimmed but faithful. The
module import is always `import ComposableArchitecture` (it re-exports CasePaths, Dependencies,
Sharing, IdentifiedCollections, and the navigation libraries).

## 1.26.0 idioms to internalize first

These shape everything below; they are the "modern" TCA that differs from older tutorials:

- **`@Reducer` + `@ObservableState`, no `ViewStore`/`WithViewStore`.** Views hold a plain
  `let store: StoreOf<Feature>` (or `@Bindable var store` when binding) and read `store.field`
  directly. `WithViewStore` is legacy — do not introduce it.
- **`@Reducer` works on enums.** A `@Reducer enum Destination` / `@Reducer enum Path` composes
  mutually-exclusive child features for navigation. This is the standard navigation idiom.
- **`@CasePathable`** is auto-applied to `Action` enums by `@Reducer`, enabling key-path action
  syntax: `store.scope(\.path, action: \.path)`, `store.receive(\.delegate.saved)`.
- **`@Presents`** replaces the old `@PresentationState` (property wrappers are incompatible with
  `@ObservableState`).
- **Shared mutations go through `withLock`**: `state.$shared.withLock { $0 = ... }`.
- **Tests use Swift Testing** (`@Test`, `await store.send`, `await store.receive(\.key.path)`),
  with `withDependencies:` as a trailing closure on `TestStore.init`.

## Topic index

Read the referenced files; do not rely on memory for API shapes.

### 1. `@Reducer` + `@ObservableState` (the unit of a feature)

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/01-GettingStarted-Counter.swift` (state `:14-17`, view `:38-59`). Macro definition: `Sources/ComposableArchitecture/Macros.swift:6-21` and `:118-125`.
- **Reference app:** `examples/reference-app/EditNoteFeature.swift` — a full feature: `@ObservableState` struct, `Action`, `@Dependency`, `body`.

### 2. View ↔ `Store` / `StoreOf` (and where views live)

- **TCA:** Counter file above, view at `:38-39`; `Sources/ComposableArchitecture/Store.swift:117` (`Store`), `:496` (`StoreOf`).
- **Reference app:** `examples/reference-app/EditNoteView.swift` and `examples/reference-app/RootView.swift` — note the reference app keeps **reducers in an SPM package and views in the app target**, importing the feature module. Views use `@Bindable var store: StoreOf<Feature>` and bind with `$store.field`.

### 3. `Scope` and composing a parent with children

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/01-GettingStarted-Composition-TwoCounters.swift` (reducer `:24-31`, view `store.scope` `:46-52`). `Sources/ComposableArchitecture/Reducer/Reducers/Scope.swift:101`.
- **Reference app:** `examples/reference-app/RootFeature.swift` — `Scope(state:action:) { NoteListFeature() }` embeds a non-optional child, then routes child `.delegate` actions.

### 3b. Collections of child features (`.forEach` over `IdentifiedArray`)

For a _list of independently-stateful rows_ (as opposed to one child, or a navigation stack): hold `IdentifiedArrayOf<Child.State>` in state, an action case `case rows(IdentifiedActionOf<Child>)`, and compose with `.forEach(\.rows, action: \.rows) { Child() }`. Drive the SwiftUI list with `ForEach(store.scope(state: \.rows, action: \.rows))`. Use `IdentifiedArray`, never a plain `[Child.State]`, so rows are addressed by stable id rather than index.

- **TCA:** `.claude/references/swift-composable-architecture/Examples/Todos/Todos/Todos.swift` (state `IdentifiedArrayOf<Todo.State>` `:16`, `.forEach(\.todos, action: \.todos)` `:99-101`). Operator definition: `Sources/ComposableArchitecture/Reducer/Reducers/ForEachReducer.swift`.
- **Reference app:** the reference app's lists are value-type rows rendered from a `@Fetch` query, not a `.forEach` of child reducers — so the authoritative example here is the TCA Todos case study. Reach for `.forEach`-of-children only when each row needs its own reducer logic/effects. If a row is just display plus a tap that bubbles up, keep the rows as value types in the parent and emit a parent action on tap, which is simpler.

### 4. `@Dependency` + `DependencyValues`

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/FactClient.swift` (`@DependencyClient` + `DependencyValues` extension), declared at `03-Effects-Basics.swift:38-39`. Richer client: `Examples/Search/Search/WeatherClient.swift`.
- **Reference app:** `examples/reference-app/RemoteConfigClient.swift` (struct-of-closures `DependencyKey` with `liveValue`/`testValue`/`previewValue`) and the `@DependencyEntry` registration in `examples/reference-app/NoteService.swift`.
- Wrap each external seam (network, persistence, system service, anything non-deterministic) as a dependency client. The struct-of-closures shape makes them trivially swappable in `TestStore`, where you override only the closures a test exercises.

### 5. Effects and async work

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/03-Effects-Basics.swift:70-77` (`.run`), `03-Effects-Cancellation.swift:47-54` (`.cancellable`), and `Examples/Search/Search/SearchView.swift:164-169` (debounce via `.task(id:)` + `Task.sleep`, the 1.26.0 idiom).
- **Reference app:** `examples/reference-app/NoteListFeature.swift` — `.run(name:)`, a `CancelID` enum, and inline `@Dependency(\.defaultDatabase)` reads inside an effect.
- **Effect vocabulary** (return one from `Reduce`): `.none` (state change only); `.run { send in }` (async); `.cancellable(id:cancelInFlight:)` + `.cancel(id:)` (replaceable/long-running — `cancelInFlight: true` supersedes a same-id effect in flight, the reducer-side way to debounce); `.merge(...)` (run several effects in parallel); `.concatenate(...)` (run them in order). Combinator definitions: `Sources/ComposableArchitecture/Effect.swift:229` (`merge`) and `:313` (`concatenate`). `.merge`/`.concatenate` usage in a feature: `Examples/VoiceMemos/VoiceMemos/VoiceMemo.swift`.

### 6. `BindableAction` + `BindingReducer` (forms)

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/01-GettingStarted-Bindings-Forms.swift` (reducer `:15-46`, view `:49-87`).
- **Reference app:** `examples/reference-app/EditNoteFeature.swift` — `Action: BindableAction`, `body` starts with `BindingReducer()`, view binds with `$store.note.title` (see `EditNoteView.swift`).

### 7. Tree-based navigation (`@Presents`, `PresentationAction`, `ifLet`, the `Destination` enum)

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/04-Navigation-Multiple-Destinations.swift` (reducer `:9-47`, view `:69-83`). Production usage: `Examples/SyncUps/SyncUps/SyncUpDetail.swift`.
- **Reference app:** `examples/reference-app/RootFeature.swift` (the `@Reducer enum Destination` + single `@Presents var destination` + `.ifLet`) and `examples/reference-app/RootView.swift` (presenting with `$store.scope(state:action:)`). The reference app is **100% tree-based**.
- Sheets and alerts are `@Presents` slots on the parent. A deep link or router can drive navigation by setting the `Destination` directly.

### 8. Stack-based navigation (`StackState` / `NavigationStack(path:)`)

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/04-NavigationStack.swift` (`@Reducer enum Path`, `StackState`, `.forEach(\.path, action: \.path)` `:8-66`, view `:74-109`). Coordinator: `Examples/SyncUps/SyncUps/AppFeature.swift`.
- **Reference app:** **Not used** — the reference app is entirely tree-based; multi-step editors are a single reducer with a `step` enum (see `examples/reference-app/NoteEditorFeatureTests.swift` for the shape). So the authoritative example here is the TCA case study, not the reference app.
- For a drill-down stack (list -> detail -> sub-detail), model the path with `StackState<Path.State>` and `NavigationStack(path: $store.scope(\.path, action: \.path))`, and a deep link appends a case onto the path. If the hierarchy is shallow (a list plus a presented detail), tree-based navigation (topic 7) is enough; reach for a stack when you need arbitrary-depth drill-down.

### 9. `@Shared` state and persistence keys

- **TCA:** Sharing case studies: `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/02-SharedState-UserDefaults.swift` (`.appStorage`), `02-SharedState-FileStorage.swift` (`.fileStorage`), `02-SharedState-InMemory.swift`.
- **Reference app:** `examples/reference-app/AppStorage.swift` — type-safe `SharedReaderKey` extensions over `.appStorage`, mutated with `state.$key.withLock { ... }`.
- Use `@Shared(.appStorage(...))` for small device-local **user preferences**, not for primary domain data. Domain data belongs in your database or persistence layer behind a dependency client (topic 4), with reactive reads driving the UI.

### 10. Testing with `TestStore`

- **TCA:** `.claude/references/swift-composable-architecture/Examples/SyncUps/SyncUpsTests/SyncUpDetailTests.swift:23-78` (modern async Swift Testing, dependency overrides, `store.receive(\.delegate.startMeeting)`). Definition: `Sources/ComposableArchitecture/TestStore.swift:430`.
- **Reference app:** `examples/reference-app/NoteEditorFeatureTests.swift` — `TestStore(initialState:) { Feature() } withDependencies: { $0.defaultDatabase = ...; $0.someClient = .testValue }`, `await store.send { $0.mutated = ... }`, `store.exhaustivity = .off` when `@Fetch`/observation emits hard-to-enumerate actions.
- Make every reducer a `TestStore` test: override each dependency the feature touches with a deterministic `testValue`, then assert every state mutation and every received effect.

### 11. Higher-order reducers (cross-cutting concerns)

For behavior that wraps _any_ feature uniformly — analytics, logging, a reusable favoriting/download component — write a `Reducer` extension that returns a reducer wrapping `self`, and chain it in `body` (`SomeFeature().analytics(tracker)`). This keeps the cross-cutting logic out of every `switch` and composes like any other reducer.

- **TCA:** `.claude/references/swift-composable-architecture/Examples/CaseStudies/SwiftUICaseStudies/05-HigherOrderReducers-ReusableFavoriting.swift` (a generic `@Reducer Favoriting<ID>` reused across features) and `05-HigherOrderReducers-Recursion.swift`. Built-in HORs to know: `.ifLet`, `.forEach`, `._printChanges()`, and `BindingReducer()` are themselves higher-order reducers.
- Reach for this sparingly. A reducer extension that emits an analytics or telemetry event per action (without otherwise touching state) is the typical real use. Do not reinvent navigation or binding HORs; TCA ships them.

## Critical rules (quick checklist)

A compact review checklist; each line traces to a topic above.

**Do:**

- Keep reducers pure — every side effect leaves as an `Effect` (`.run`/`.cancellable`/`.merge`/`.concatenate`), never inline `await`/`Task {}` in the `switch`. (topic 5)
- Hold collections as `IdentifiedArrayOf`, never `[Child.State]` indexed by position. (topic 3b)
- Use delegate actions for child -> parent communication; the child never reaches into the parent. (topics 3, 7)
- Make `State` a value-type `struct: Equatable` (and `Sendable`); construct `Store` once at the scene root and `scope` it down. (topics 1, 2)
- In tests, override every dependency the feature touches and assert all state mutations + received effects. (topic 10)

**Do not:**

- Mutate state outside a reducer, or run async work directly in a reducer.
- Create a `Store` inside a view, or mix `@State`/`@StateObject` with TCA-managed state.
- Introduce `ViewStore`/`WithViewStore` or `@PresentationState` — both are legacy; use `@ObservableState` + `@Bindable var store` and `@Presents`.
- Hold reference types or externally-mutated objects in TCA `State`; keep it value types so equality and replay hold. (topic 1)

## Reference files in this skill

Read these when the topic comes up:

- `references/docc-index.md` — a map of TCA's own DocC documentation (the conceptual Articles, the
  version migration guides, and the per-symbol Extensions) vendored in the submodule. Use it when you
  want the **reasoning and modeling tradeoffs** behind a pattern, not just the code shape — e.g.
  "tree vs stack navigation," "how `@Shared` persistence works," or recognizing a legacy API to
  replace.

## Copied reference-app examples (self-contained)

All of `examples/reference-app/` is adapted (trimmed) from a production TCA reference app, with the
domain renamed to a neutral "notes" example, and each file carries a header noting that. Nothing in
this skill depends on any external repo. Treat the reference app's _structure and TCA usage_ as the
template. It persists with SQLiteData (`@Table` value-type rows plus a CloudKit `SyncEngine`); if
your app uses a different persistence layer, keep the same dependency-client and reactive-read shape
and swap the storage mechanics underneath.
