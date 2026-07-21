# TCA 1.26.0 DocC documentation index

The vendored submodule ships TCA's full DocC documentation as prose Markdown. These are the
**authoritative conceptual guides** (the "why" and the modeling tradeoffs), complementing the
code-level `Examples/` pointers in `SKILL.md`. Read the relevant article when you need the reasoning
behind a pattern, not just the API shape.

All paths below are relative to:
`.claude/references/swift-composable-architecture/Sources/ComposableArchitecture/Documentation.docc/`

The umbrella overview is `ComposableArchitecture.md` (the library's landing page / table of
contents). Two complete tutorial tracks live under `Tutorials/`
(`MeetTheComposableArchitecture/` and `BuildingSyncUps/`) — work through those for guided,
step-by-step learning; they pair with the `Examples/SyncUps` app cited in `SKILL.md`.

## Articles (the conceptual guides — start here)

Each line: file -> what it teaches, and which `SKILL.md` topic it backs.

- `Articles/GettingStarted.md` — integrating TCA into a project and writing your first feature.
  (SKILL topics 1-2.)
- `Articles/DependencyManagement.md` — registering dependencies so any reducer can reach them via
  `@Dependency`; live/test/preview values. (SKILL topic 4.)
- `Articles/Bindings.md` — connecting TCA features to SwiftUI two-way bindings (`BindableAction` +
  `BindingReducer`, `@Bindable var store`, `$store.field`). (SKILL topic 6.)
- `Articles/WhatIsNavigation.md` — the two forms of state-driven navigation (tree vs stack) and their
  tradeoffs. **Read before choosing a navigation style.** (SKILL topics 7-8.)
- `Articles/Navigation.md` — the overall navigation tooling: modeling domains, wiring the reducer and
  view layers, and testing navigation. (SKILL topics 7-8.)
- `Articles/TreeBasedNavigation.md` — navigation modeled with optionals/enums (`@Presents`,
  `PresentationAction`, `ifLet`, the `Destination` enum). (SKILL topic 7.)
- `Articles/StackBasedNavigation.md` — navigation modeled with collections (`StackState`/`StackAction`,
  `NavigationStack(path:)`, `forEach`). Relevant for drill-down stack navigation and for a deep link
  appending onto the path. (SKILL topic 8.)
- `Articles/SharingState.md` — sharing state across features and persisting to user defaults, the file
  system, and other backends (`@Shared`, `.appStorage`/`.fileStorage`/`.inMemory`). (SKILL topic 9.)
- `Articles/TestingTCA.md` — writing exhaustive `TestStore` tests; overriding dependencies; controlling
  effects and exhaustivity. (SKILL topic 10.)
- `Articles/SwiftConcurrency.md` — writing safe concurrent effects with structured concurrency
  (`Sendable`, `.run`, cancellation). Useful for any async or long-running effect. (SKILL topic 5.)
- `Articles/Performance.md` — diagnosing and fixing reducer/store performance problems as features grow
  (over-scoping, unnecessary recomputation, `_printChanges`).
- `Articles/FAQ.md` — common questions/misconceptions, usually pointing at the current idiom. Skim when
  an older tutorial conflicts with what `SKILL.md` says.
- `Articles/ObservationBackport.md` — how Observation was backported to iOS 16; only relevant if your
  deployment target predates the Observation framework, but it explains `@ObservableState` internals
  if you hit observation oddities.

## Migration guides (version-to-version upgrade notes)

`Articles/MigrationGuides.md` is the index. Individual guides under `Articles/MigrationGuides/` cover
`MigratingTo1.4.md` through `MigratingTo1.25.md` (the submodule is pinned to **1.26.0**, so 1.25 is the
latest applicable guide). Read these when an example or older snippet uses a pre-1.26 API and you need
the modern replacement. The highest-leverage ones for the idioms this skill teaches:

- `MigratingTo1.7.md` — the `@Reducer` macro and the move off manual `Reducer` conformances.
- `MigratingTo1.16.md` / `MigratingTo1.17.md` / `MigratingTo1.17.1.md` — observation and the shift away
  from `ViewStore`/`WithViewStore` to `@ObservableState` + direct `store.field` access.
- `MigratingTo1.25.md` — the most recent changes before the pinned 1.26.0.

(Use these to recognize and replace legacy patterns — `WithViewStore`, `@PresentationState`,
`IfLetStore`/`ForEachStore`, `Effect.task` — none of which should appear in new code.)

## Extensions (per-symbol API docs)

`Extensions/` holds DocC stubs for individual symbols (`Extensions/Reducer.md`,
`Extensions/Store.md`, `Extensions/Effect.md`, `Extensions/ObservableState.md`,
`Extensions/Presents.md`, `Extensions/TestStore.md`, `Extensions/IdentifiedAction.md`, etc.). These are
narrow API reference pages, useful for a specific symbol's contract. For learning a topic, prefer the
Articles above and the `Examples/` code in `SKILL.md` — reach into `Extensions/` only when you need one
symbol's exact documentation.

Note: `Extensions/Deprecations/*` and the `ViewStore.md`/`WithViewStore.md`/`SwitchStore.md` pages
document **legacy** APIs. They are useful for understanding old code you encounter, but do not adopt
those APIs in new code (see `SKILL.md` "1.26.0 idioms to internalize first").
