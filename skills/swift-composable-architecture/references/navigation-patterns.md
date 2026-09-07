# Navigation patterns and pitfalls

Practical guidance that sits on top of topics 7 (tree-based navigation) and 8
(stack-based navigation) in `SKILL.md`. Read `SKILL.md` first for the API
shapes and the authoritative TCA 1.26.2 paths; read this when you are deciding
_which_ pattern to reach for, or when navigation is misbehaving at runtime.

## Choosing a pattern

```
Need navigation?
│
├─ One level (sheet, popover, full-screen cover, alert)?
│   └─ Tree-based: @Reducer enum Destination + a single @Presents slot + .ifLet
│
├─ Arbitrary-depth drill-down (list -> detail -> edit)?
│   └─ Stack-based: @Reducer enum Path + StackState + .forEach(\.path, action: \.path)
│
├─ Both modals and drill-down in the same feature?
│   └─ Combine them: Destination for the modals, Path for the stack
│
├─ Child needs to hand something back to the parent?
│   └─ Delegate action: case delegate(Delegate) with a nested enum
│
└─ Presentation shows a spinner before content appears?
    └─ Preload the child state before assigning the destination
```

## One `Destination` enum, not one optional per modal

A feature that can present several modals should hold **one** `@Presents var
destination: Destination.State?`, not a separate `@Presents var addItem`,
`@Presents var editItem`, and so on.

Separate optionals make illegal states representable: nothing stops two of them
being non-nil at once, and SwiftUI will present whichever it notices first and
silently drop the other. A single enum slot makes the mutual exclusion a
compile-time property, gives you one `.ifLet` instead of N, and lets a deep link
or router set the whole navigation state in one assignment.

```swift
@Reducer
public enum Destination {
    case addItem(AddItemFeature)
    case editItem(EditItemFeature)
    case settings(SettingsFeature)
}

@ObservableState
public struct State: Equatable {
    @Presents public var destination: Destination.State?
}

public enum Action {
    case destination(PresentationAction<Destination.Action>)
}

public var body: some Reducer<State, Action> {
    Reduce { state, action in
        // ...
    }
    .ifLet(\.$destination, action: \.destination)
}
```

In the view, scope into the case you want to present:

```swift
.sheet(item: $store.scope(state: \.destination?.addItem, action: \.destination.addItem)) { store in
    AddItemView(store: store)
}
.sheet(item: $store.scope(state: \.destination?.editItem, action: \.destination.editItem)) { store in
    EditItemView(store: store)
}
```

Alerts stay in their own `@Presents var alert: AlertState<Action.Alert>?` slot,
because `.alert(_:)` takes `AlertState` rather than a child feature.

See `examples/reference-app/RootFeature.swift` and
`examples/reference-app/RootView.swift` for this shape in a real feature.

## Preloading: present with content already there

The default presentation flow shows the modal first and loads inside it, so the
user sees a spinner every time:

1. User taps a row.
2. The sheet animates in.
3. The child sends `.onAppear`, starts a request, shows a `ProgressView`.
4. Content pops in, resizing the sheet.

Preloading inverts steps 2 and 3. The parent builds the child's `State`
asynchronously, then assigns the destination only once the data is in hand, so
the sheet animates in already populated.

Give the child a `static` factory that produces a fully loaded `State`. Keep the
loading behind a dependency client (topic 4) so it is still overridable in
tests:

```swift
@Reducer
public struct DetailFeature {
    @ObservableState
    public struct State: Equatable {
        public var item: Item
        public var comments: [Comment] = []
    }

    // Called by the parent before presentation.
    public static func preload(item: Item) async throws -> State {
        @Dependency(\.itemClient) var itemClient
        return State(item: item, comments: try await itemClient.comments(item.id))
    }
}
```

The parent runs it as an ordinary effect and assigns the destination on success:

```swift
case let .itemTapped(item):
    state.isPreparingNavigation = true
    return .run { send in
        await send(.detailReady(Result { try await DetailFeature.preload(item: item) }))
    }

case let .detailReady(.success(childState)):
    state.isPreparingNavigation = false
    state.destination = .detail(childState)
    return .none

case let .detailReady(.failure(error)):
    state.isPreparingNavigation = false
    state.alert = .loadFailed(error)
    return .none
```

Track the in-flight preload in state so the tap target can show progress and
reject double taps, otherwise a slow load looks like the tap was ignored:

```swift
Button { store.send(.itemTapped(item)) } label: {
    ItemRow(item: item)
}
.disabled(store.isPreparingNavigation)
.overlay { if store.isPreparingNavigation { ProgressView() } }
```

Trade-offs: preloading delays the presentation by the length of the request, so
it is right for fast local reads (a database query, a cache hit) and wrong for a
slow network call, where the user is better served by an immediate sheet with a
skeleton. It also means a failed load produces no presentation at all, so always
handle the failure case with a visible alert rather than `.none`. Because the
effect always runs to completion, wrap it with `.cancellable(id:cancelInFlight:
true)` if the user can tap a second row while the first is loading.

## Store lifecycle: do not rebuild a store inside a view closure

Every store TCA presents through `@Presents`, `StackState`, or
`store.scope(...)` is owned by the parent store, so its lifetime is driven by
state. A store you construct yourself inside a view closure is not: it lives
exactly as long as the closure's result, and SwiftUI re-evaluates that closure
whenever the surrounding view body is invalidated.

```swift
// Wrong: a fresh store, with fresh initial state, on every re-render.
.navigationDestination(for: SettingsRoute.self) { route in
    switch route {
    case .itemOrder:
        ItemOrderView(
            store: Store(initialState: ItemOrderFeature.State()) { ItemOrderFeature() }
        )
    }
}
```

The failure is easy to miss because it needs a re-render to trigger. A typical
sequence:

1. The child holds `@Shared(.appStorage("sortOrder"))`.
2. The user changes the sort order.
3. `@Shared` writes through to `UserDefaults` and notifies observers.
4. SwiftUI invalidates the parent body and re-runs the destination closure.
5. A new store is built with empty initial state.
6. Everything the child had loaded is gone, and the view flashes back to empty.

If the destination genuinely has to own its own store rather than being scoped
from the parent, build it once and hold it in `@State`:

```swift
struct SettingsView: View {
    @State private var itemOrderStore = Store(initialState: ItemOrderFeature.State()) {
        ItemOrderFeature()
    }

    var body: some View {
        NavigationStack {
            // ...
        }
        .navigationDestination(for: SettingsRoute.self) { route in
            switch route {
            case .itemOrder:
                ItemOrderView(store: itemOrderStore)
            }
        }
    }
}
```

Prefer scoping from the parent store (`$store.scope(state:action:)`) over a
`@State` store wherever the child's presentation is already modeled in parent
state. The `@State` escape hatch is for a long-lived child that the parent does
not otherwise model.

When it bites:

| Situation                                         | Risk |
| ------------------------------------------------- | ---- |
| Child holds `@Shared` state that the user mutates | High |
| Parent holds `@Shared` state that changes         | High |
| Child accumulates loaded data over its lifetime   | High |
| Short-lived modal with no loaded state            | Low  |
| Purely presentational child                       | Low  |

To confirm this is what you are seeing, print from both sides: log the count in
the reducer when the response lands, and log it again in the view body. A
reducer that reports "loaded 24 items" while the body renders 0 means the view
is reading a different, newer store than the one the effect fed. `._printChanges()`
on the child reducer shows the same thing: a second `State` initializing from
scratch right after the shared value changes.
