---
name: swift-tca
description: This skill should be used when the user asks to "create a TCA feature", "add a TCA reducer", "implement TCA navigation", "add a TCA modal", "present a TCA sheet", "use @ObservableState", "add StackState navigation", "implement @Presents", "handle TCA effects", "use Effect.run", "add BindableAction for forms", "create TCA bindings", "use the Delegate pattern", "child-to-parent communication in TCA", or mentions "composable architecture", "pointfree TCA", "TCA state", "TCA action". Covers reducer creation, navigation patterns (Unified Destination, StackState), effect handling, forms with bindings, and parent-child communication.
effort: medium
---

# TCA Feature Development

Patterns for developing features using The Composable Architecture (TCA) with Swift and SwiftUI.

## Quick Reference

| Pattern                 | When to Use                           | Key Types                                     |
| ----------------------- | ------------------------------------- | --------------------------------------------- |
| **Unified Destination** | Multiple modals/sheets from one view  | `@Reducer enum Destination` + `@Presents`     |
| **StackState**          | Drill-down navigation (list → detail) | `StackState<Path.State>` + `.forEach`         |
| **Preloading**          | Jank-free modal presentation          | `static func preload() async throws -> State` |
| **Service Layer**       | Database writes, side effects         | `@Dependency(\.myService)`                    |
| **BindableAction**      | Forms with two-way binding            | `BindingReducer()` first in body              |
| **Delegate**            | Child-to-parent communication         | `case delegate(Delegate)` sub-enum            |
| **@State Store**        | Navigation with @Shared children      | `@State private var store = Store(...)`       |

## Feature Anatomy

Every TCA feature has four components: State, Action, Reducer, and View.

### 1. State

```swift
@Reducer
public struct MyFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        // Data from database queries
        @ObservationStateIgnored
        @Fetch
        public var data = MyRequest.Value()

        // Shared preferences (cross-app state)
        @Shared(.myPreference)
        public var preference = false

        // Navigation (modals/sheets)
        @Presents
        public var destination: Destination.State?

        // Alerts
        @Presents
        public var alert: AlertState<Action.Alert>?

        // Local UI state
        public var isLoading = false

        // Custom Equatable: EXCLUDE @Shared and @Fetch
        public static func == (lhs: State, rhs: State) -> Bool {
            lhs.isLoading == rhs.isLoading &&
            lhs.data.rows == rhs.data.rows
        }
    }
}
```

**Key patterns:**

- `@ObservationStateIgnored` for expensive properties (`@Fetch`)
- `@Shared` for cross-app preferences (from swift-sharing)
- Custom `Equatable` that excludes `@Shared` and `@Fetch` fields
- Single `@Presents var destination` for ALL modals (Unified Destination pattern)

### 2. Actions

```swift
public enum Action: Sendable {
    // Lifecycle
    case onAppear
    case onDisappear

    // User interactions
    case addButtonTapped
    case itemTapped(Item)
    case deleteConfirmed(Item.ID)

    // Async request/response pairs
    case loadDataRequest
    case loadDataResponse(Result<Void, Error>)

    // Delegate for parent communication
    case delegate(Delegate)

    public enum Delegate: Equatable, Sendable {
        case dismiss
        case itemCreated(Item)
    }

    // Child feature actions
    case destination(PresentationAction<Destination.Action>)
    case alert(PresentationAction<Alert>)

    public enum Alert: Equatable, Sendable {
        case confirmDelete
    }
}
```

**Key patterns:**

- `Result<T, Error>` for async responses
- `Delegate` sub-enum for parent communication
- `PresentationAction<T>` for modals and alerts

### 3. Reducer Body

```swift
public var body: some Reducer<State, Action> {
    Reduce { state, action in
        switch action {
        case .onAppear:
            return .send(.loadDataRequest)

        case .loadDataRequest:
            state.isLoading = true
            return .run(name: "LoadData") { [data = state.$data] send in
                await send(.loadDataResponse(
                    Result { try await data.load(MyRequest(), animation: .default) }
                ))
            }

        case .loadDataResponse(.success):
            state.isLoading = false
            return .none

        case .loadDataResponse(.failure(let error)):
            state.isLoading = false
            Logger.ui.error("Load failed: \(error)")
            return .none

        case .delegate:
            return .none  // Parent handles

        case .destination, .alert:
            return .none  // Handled by .ifLet below
        }
    }
    .ifLet(\.$destination, action: \.destination)
    .ifLet(\.$alert, action: \.alert)
}
```

**Key patterns:**

- Shared reducers (`BindingReducer`) BEFORE `Reduce`
- Named effects with `.run(name:)` for debugging
- `.ifLet` for optional destinations at END of body

### 4. View Integration

```swift
struct MyView: View {
    @Bindable var store: StoreOf<MyFeature>

    var body: some View {
        List {
            ForEach(store.data.rows) { row in
                Button { store.send(.itemTapped(row)) } label: {
                    Text(row.name)
                }
            }
        }
        .onAppear { store.send(.onAppear) }
        .onDisappear { store.send(.onDisappear) }
        .sheet(item: $store.scope(state: \.destination?.addItem, action: \.destination.addItem)) { store in
            AddItemView(store: store)
        }
        .alert($store.scope(state: \.alert, action: \.alert))
    }
}
```

## Navigation Patterns

See [references/NAVIGATION.md](references/NAVIGATION.md) for detailed navigation patterns including:

- Unified Destination enum
- StackState for drill-down
- Preloading for jank-free presentation
- Delegate pattern for dismissal

### Quick Navigation Summary

**Modals/Sheets (Unified Destination):**

```swift
@Reducer
public enum Destination: Sendable {
    case addItem(AddItemFeature)
    case editItem(EditItemFeature)
    case settings(SettingsFeature)
}

// In State:
@Presents public var destination: Destination.State?

// In Reducer body:
.ifLet(\.$destination, action: \.destination)
```

**Drill-down Navigation (StackState):**

```swift
@Reducer
public enum Path: Sendable {
    case detail(DetailFeature)
}

// In State:
public var path = StackState<Path.State>()

// In Reducer body:
.forEach(\.path, action: \.path)
```

## Effects & Dependencies

**CRITICAL: All database writes go through the service layer.**

```swift
// In Feature:
@Dependency(\.itemService) var itemService

case .createItem(let item):
    return .run(name: "CreateItem") { [itemService] send in
        await send(.createItemResponse(
            Result { try await itemService.create(item) }
        ))
    }
```

Services automatically coordinate:

- Database writes
- Widget reloads
- Notification scheduling
- Logging

## Forms with BindableAction

For forms with two-way binding:

```swift
public enum Action: BindableAction, Sendable {
    case binding(BindingAction<State>)  // Required
    case saveButtonTapped
}

public var body: some Reducer<State, Action> {
    BindingReducer()  // MUST be first!

    Reduce { state, action in
        switch action {
        case .binding:
            return .none  // Handled automatically
        case .saveButtonTapped:
            // Save logic
        }
    }
}
```

In View:

```swift
TextField("Name", text: $store.name)
Toggle("Enabled", isOn: $store.isEnabled)
```

## Code Examples

For complete, copy-paste-ready examples, see [examples/EXAMPLES.md](examples/EXAMPLES.md).
