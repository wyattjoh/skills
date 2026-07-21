# TCA Navigation Patterns

Comprehensive guide to navigation in TCA features.

## Pattern Overview

| Pattern                 | Use Case                                     | Key Types                   |
| ----------------------- | -------------------------------------------- | --------------------------- |
| **Unified Destination** | Multiple modals/sheets from one feature      | `@Reducer enum Destination` |
| **StackState**          | Drill-down navigation (list → detail → edit) | `StackState<Path.State>`    |
| **Preloading**          | Load data before presentation                | `static func preload()`     |
| **Delegate Dismissal**  | Child signals parent to dismiss              | `case delegate(Delegate)`   |

## 1. Unified Destination Pattern

Instead of multiple `@Presents` properties, use a single `Destination` enum.

### Why Unified Destination?

**Bad (multiple @Presents):**

```swift
@Presents var addItem: AddItemFeature.State?
@Presents var editItem: EditItemFeature.State?
@Presents var settings: SettingsFeature.State?
```

Problems:

- Multiple optional properties to track
- Complex `Equatable` implementation
- Harder to reason about "what's currently showing"

**Good (Unified Destination):**

```swift
@Reducer
enum Destination: Sendable {
    case addItem(AddItemFeature)
    case editItem(EditItemFeature)
    case settings(SettingsFeature)
}

@Presents var destination: Destination.State?
```

Benefits:

- Single source of truth
- Only one modal can be active
- Simpler `Equatable`
- Type-safe navigation

### Implementation

```swift
@Reducer
public struct MyFeature: Sendable {
    // 1. Define Destination as a nested @Reducer enum
    @Reducer
    public enum Destination: Sendable {
        case addItem(AddItemFeature)
        case editItem(EditItemFeature)
        case settings(SettingsFeature)
    }

    @ObservableState
    public struct State: Equatable {
        // 2. Single @Presents for all destinations
        @Presents
        public var destination: Destination.State?
    }

    public enum Action: Sendable {
        // 3. Single action for all destinations
        case destination(PresentationAction<Destination.Action>)

        case addButtonTapped
        case editButtonTapped(Item)
        case settingsButtonTapped
    }

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case .addButtonTapped:
                state.destination = .addItem(AddItemFeature.State())
                return .none

            case .editButtonTapped(let item):
                state.destination = .editItem(EditItemFeature.State(item: item))
                return .none

            case .settingsButtonTapped:
                state.destination = .settings(SettingsFeature.State())
                return .none

            case .destination:
                return .none
            }
        }
        // 4. Single .ifLet for all destinations
        .ifLet(\.$destination, action: \.destination)
    }
}
```

### View Integration

```swift
struct MyView: View {
    @Bindable var store: StoreOf<MyFeature>

    var body: some View {
        List { /* ... */ }
        // Each destination type gets its own modifier
        .sheet(item: $store.scope(state: \.destination?.addItem, action: \.destination.addItem)) { store in
            AddItemView(store: store)
        }
        .sheet(item: $store.scope(state: \.destination?.editItem, action: \.destination.editItem)) { store in
            EditItemView(store: store)
        }
        .sheet(item: $store.scope(state: \.destination?.settings, action: \.destination.settings)) { store in
            SettingsView(store: store)
        }
    }
}
```

## 2. StackState for Drill-Down Navigation

Use `StackState` for push/pop navigation like list → detail.

### Implementation

```swift
@Reducer
public struct ListFeature: Sendable {
    // 1. Define Path enum for navigation destinations
    @Reducer
    public enum Path: Sendable {
        case detail(DetailFeature)
        case edit(EditFeature)
    }

    @ObservableState
    public struct State: Equatable {
        // 2. StackState for the navigation path
        public var path = StackState<Path.State>()
        public var items: [Item] = []
    }

    public enum Action: Sendable {
        // 3. StackActionOf for path actions
        case path(StackActionOf<Path>)
        case itemTapped(Item)
        case detailNavigationReady(Result<DetailFeature.State, Error>)
    }

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case .itemTapped(let item):
                // Preload before pushing
                return .run { send in
                    await send(.detailNavigationReady(
                        Result { try await DetailFeature.preload(item: item) }
                    ))
                }

            case .detailNavigationReady(.success(let childState)):
                // Push to stack
                state.path.append(.detail(childState))
                return .none

            case .detailNavigationReady(.failure):
                return .none

            // Handle child delegate actions
            case .path(.element(id: _, action: .detail(.delegate(.editTapped(let item))))):
                state.path.append(.edit(EditFeature.State(item: item)))
                return .none

            case .path(.element(id: _, action: .edit(.delegate(.saved)))):
                // Pop back to list after save
                _ = state.path.popLast()
                _ = state.path.popLast()
                return .none

            case .path:
                return .none
            }
        }
        // 4. forEach for stack navigation
        .forEach(\.path, action: \.path)
    }
}
```

### View Integration

```swift
struct ListView: View {
    @Bindable var store: StoreOf<ListFeature>

    var body: some View {
        NavigationStack(path: $store.scope(state: \.path, action: \.path)) {
            List(store.items) { item in
                Button { store.send(.itemTapped(item)) } label: {
                    ItemRow(item: item)
                }
            }
            .navigationTitle("Items")
        } destination: { store in
            // Switch on the path case
            switch store.case {
            case .detail(let store):
                DetailView(store: store)
            case .edit(let store):
                EditView(store: store)
            }
        }
    }
}
```

## 3. Preloading Pattern

Load child feature data BEFORE presentation to eliminate loading spinners.

### Why Preload?

Without preloading:

1. User taps item
2. Modal appears
3. Loading spinner shows
4. Data loads
5. Content appears

With preloading:

1. User taps item
2. Data loads (in background)
3. Modal appears with content ready

### Implementation

```swift
// Child Feature
@Reducer
public struct DetailFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        @ObservationStateIgnored
        @Fetch
        var data = DetailRequest.Value()

        var item: Item

        public init(item: Item) {
            self.item = item
        }
    }

    // Preload function - called by parent before presentation
    nonisolated public static func preload(item: Item) async throws -> State {
        var state = State(item: item)
        try await state.$data.load(DetailRequest(itemID: item.id), animation: .spring())
        return state
    }
}

// Parent Feature
@Reducer
public struct ListFeature: Sendable {
    public enum Action: Sendable {
        case itemTapped(Item)
        case prepareDetail(Item)
        case detailReady(Result<DetailFeature.State, Error>)
        case destination(PresentationAction<Destination.Action>)
    }

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case .itemTapped(let item):
                // Start preloading
                return .send(.prepareDetail(item))

            case .prepareDetail(let item):
                return .run(name: "PrepareDetail") { send in
                    await send(.detailReady(
                        Result { try await DetailFeature.preload(item: item) }
                    ))
                }

            case .detailReady(.success(let childState)):
                // Present with data already loaded
                state.destination = .detail(childState)
                return .none

            case .detailReady(.failure(let error)):
                Logger.ui.error("Failed to prepare detail: \(error)")
                return .none
            }
        }
    }
}
```

### Loading Indicator During Preload

Show a subtle loading indicator while preloading:

```swift
@ObservableState
public struct State: Equatable {
    @Presents var destination: Destination.State?
    var isPreparingNavigation = false  // Track preload state
}

case .prepareDetail(let item):
    state.isPreparingNavigation = true
    return .run { ... }

case .detailReady(.success(let childState)):
    state.isPreparingNavigation = false
    state.destination = .detail(childState)
    return .none

case .detailReady(.failure):
    state.isPreparingNavigation = false
    return .none
```

```swift
// In View
Button { store.send(.itemTapped(item)) } label: {
    ItemRow(item: item)
}
.disabled(store.isPreparingNavigation)
.overlay {
    if store.isPreparingNavigation {
        ProgressView()
    }
}
```

## 4. Delegate Pattern for Dismissal

Children communicate with parents via delegate actions.

### Implementation

```swift
// Child Feature
@Reducer
public struct AddItemFeature: Sendable {
    public enum Action: Sendable {
        case createButtonTapped
        case createResponse(Result<Item, Error>)
        case delegate(Delegate)

        public enum Delegate: Equatable, Sendable {
            case dismiss           // Generic dismissal
            case itemCreated(Item) // With data
        }
    }

    @Dependency(\.dismiss) var dismiss

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case .createResponse(.success(let item)):
                // Notify parent, then dismiss
                return .concatenate(
                    .send(.delegate(.itemCreated(item))),
                    .run { _ in await dismiss() }
                )

            case .delegate:
                return .none  // Parent handles
            }
        }
    }
}

// Parent Feature
public var body: some Reducer<State, Action> {
    Reduce { state, action in
        switch action {
        // Handle child delegate
        case .destination(.presented(.addItem(.delegate(.itemCreated(let item))))):
            state.destination = nil  // Dismiss modal
            // React to the created item
            return .send(.loadItemsRequest)

        case .destination:
            return .none
        }
    }
    .ifLet(\.$destination, action: \.destination)
}
```

### Delegate vs Direct Dismissal

**Use Delegate when:**

- Parent needs to react (reload data, update state)
- Parent controls the dismissal timing
- Child returns data to parent

**Use `@Dependency(\.dismiss)` when:**

- Simple dismissal with no parent reaction needed
- Cancel buttons
- After successful save when parent doesn't need the data

## 5. Combining Patterns

Real features often combine multiple patterns.

### Example: List with Detail and Edit

```swift
@Reducer
public struct ItemsFeature: Sendable {
    // Modals (Unified Destination)
    @Reducer
    public enum Destination: Sendable {
        case addItem(AddItemFeature)
        case quickEdit(QuickEditFeature)
    }

    // Drill-down (StackState)
    @Reducer
    public enum Path: Sendable {
        case detail(ItemDetailFeature)
        case fullEdit(FullEditFeature)
    }

    @ObservableState
    public struct State: Equatable {
        var items: [Item] = []
        var path = StackState<Path.State>()
        @Presents var destination: Destination.State?
    }

    public enum Action: Sendable {
        // Modal triggers
        case addButtonTapped
        case quickEditTapped(Item)

        // Drill-down triggers
        case itemTapped(Item)
        case detailNavigationReady(Result<ItemDetailFeature.State, Error>)

        // Child actions
        case path(StackActionOf<Path>)
        case destination(PresentationAction<Destination.Action>)
    }

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            // Modals - immediate presentation
            case .addButtonTapped:
                state.destination = .addItem(AddItemFeature.State())
                return .none

            case .quickEditTapped(let item):
                state.destination = .quickEdit(QuickEditFeature.State(item: item))
                return .none

            // Drill-down - preload first
            case .itemTapped(let item):
                return .run { send in
                    await send(.detailNavigationReady(
                        Result { try await ItemDetailFeature.preload(item: item) }
                    ))
                }

            case .detailNavigationReady(.success(let childState)):
                state.path.append(.detail(childState))
                return .none

            // Handle path delegates
            case .path(.element(id: _, action: .detail(.delegate(.editTapped(let item))))):
                state.path.append(.fullEdit(FullEditFeature.State(item: item)))
                return .none

            // Handle destination delegates
            case .destination(.presented(.addItem(.delegate(.itemCreated)))):
                state.destination = nil
                return .send(.loadItemsRequest)

            case .path, .destination, .detailNavigationReady(.failure):
                return .none
            }
        }
        .forEach(\.path, action: \.path)
        .ifLet(\.$destination, action: \.destination)
    }
}
```

## 6. Store Lifecycle in Navigation

**Critical**: How you create stores in navigation destinations affects state persistence.

### The Problem: Inline Store Creation

When a store is created inline in a `navigationDestination` closure, SwiftUI re-renders cause the store to be recreated with fresh initial state:

```swift
// ❌ BAD: Store recreated on every parent re-render
.navigationDestination(for: SettingsDestination.self) { destination in
    switch destination {
    case .medicationOrder:
        MedicationOrderView(
            store: Store(initialState: MedicationOrderFeature.State()) {
                MedicationOrderFeature()
            }
        )
    }
}
```

**Why this breaks:**

1. Child feature has `@Shared` state (e.g., `@Shared(.sortOption)`)
2. User changes the shared preference
3. `@Shared` updates external storage (AppStorage)
4. SwiftUI re-evaluates the parent's `navigationDestination` closure
5. New store is created with empty initial state
6. All loaded data is lost!

### The Solution: Persist Stores with @State

Create the store once and store it in `@State`:

```swift
// ✅ GOOD: Store persists across re-renders
struct SettingsView: View {
    @State
    private var medicationOrderStore = Store(initialState: MedicationOrderFeature.State()) {
        MedicationOrderFeature()
    }

    var body: some View {
        NavigationStack {
            // ...
        }
        .navigationDestination(for: SettingsDestination.self) { destination in
            switch destination {
            case .medicationOrder:
                MedicationOrderView(store: medicationOrderStore)
            }
        }
    }
}
```

### When This Matters

| Scenario                               | Risk Level | Solution            |
| -------------------------------------- | ---------- | ------------------- |
| Child has `@Shared` state that changes | **High**   | Use `@State` store  |
| Child is read-only                     | Low        | Inline is okay      |
| Parent has `@Shared` that changes      | **High**   | Use `@State` store  |
| Short-lived modals                     | Low        | Inline usually okay |

### Debugging Store Recreation

If data disappears after user interactions, add diagnostic logs:

```swift
// In child reducer
case .loadResponse(.success(let items)):
    Logger.ui.info("Loaded \(items.count) items")
    state.items = items
    return .none

// In view
let _ = print("VIEW: Rendering with items.count: \(store.items.count)")
```

If you see "Loaded X items" but the view renders with count 0, the store is being recreated.

## Decision Tree

```
Need navigation?
│
├─ Single level (modal/sheet)?
│   └─ Use Unified Destination pattern
│       └─ @Reducer enum Destination + @Presents
│
├─ Multi-level drill-down (list → detail → edit)?
│   └─ Use StackState pattern
│       └─ @Reducer enum Path + StackState
│
├─ Both modals AND drill-down?
│   └─ Combine: Destination for modals, Path for stack
│
├─ Child needs to send data to parent?
│   └─ Use Delegate pattern
│       └─ case delegate(Delegate) with sub-enum
│
└─ Need smooth transitions with no loading spinners?
    └─ Use Preloading pattern
        └─ static func preload() async throws -> State
```
