# Copied reference-app examples

Every `.swift` file here is **adapted (trimmed) from a production TCA reference app** and carries a
header comment saying so. The domain has been renamed to a neutral "notes" example (notes, folders,
tags) — the original app's name and its problem domain are not used. They are illustrative snippets,
not compilable units: referenced types (`Folder`, `Tag`, `SettingsFeature`, `HistoryFeature`,
`sideEffectCoordinator`, etc.) are elided. Nothing in this skill depends on any external repo.

The reference app is a real, shipping iOS/macOS app that uses TCA heavily, so these show how the
pieces fit in production rather than in isolated case studies.

## What each file demonstrates

| File                           | TCA topic                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EditNoteFeature.swift`        | `@Reducer` + `@ObservableState`, `BindableAction` + `BindingReducer`, `@Dependency`, `.run` effects, `@Presents` alert + `ifLet`, delegate actions |
| `EditNoteView.swift`           | Modern view idiom: `@Bindable var store: StoreOf<...>`, `$store.field` bindings, no `ViewStore`                                                    |
| `RootFeature.swift`            | Root coordinator, tree-based nav: `@Reducer enum Destination`, `@Presents`, `Scope`, delegate-driven routing, `ifLet`                              |
| `RootView.swift`               | Presenting destinations from the root view via `.sheet(item: $store.scope(...))`                                                                   |
| `NoteListFeature.swift`        | Reactive reads (`@Fetch`/`FetchKeyRequest`), cancellable effects (`CancelID`), `@Shared` in state                                                  |
| `Note.swift`                   | The persistence model as a value type (`@Table`), and why reference-type rows need a value-type snapshot                                           |
| `DatabaseBootstrap.swift`      | Installing the persistence engine + CloudKit sync as dependency values                                                                             |
| `NoteService.swift`            | The write path: a service over `@Dependency(\.defaultDatabase)`, registered with `@DependencyEntry`                                                |
| `RemoteConfigClient.swift`     | Struct-of-closures dependency client with live/test/preview values, the shape to prefer for swappable seams                                        |
| `AppStorage.swift`             | `@Shared` user-preference keys over `.appStorage`, mutated with `withLock`                                                                         |
| `NoteEditorFeatureTests.swift` | `TestStore` tests with Swift Testing, in-memory DB override, `send`/`receive`, `exhaustivity`                                                      |

## A note on persistence

The reference app persists with **SQLiteData** (`@Table` value-type rows over GRDB plus a CloudKit
`SyncEngine`), exposed as the `\.defaultDatabase` dependency with reactive reads via `@Fetch` and
writes through service structs. Because its rows are already value types, the row type can double as
TCA state. If your persistence layer uses reference types instead (for example SwiftData `@Model`
classes), keep a value-type snapshot of each row in TCA state and wrap the store behind a dependency
client, rather than holding the reference type directly. See topic 4 (dependencies) and topic 5
(effects) in `SKILL.md` for the dependency-client and reactive-read shapes that pattern builds on.
