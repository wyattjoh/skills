# TCA Code Examples

Complete, copy-paste-ready examples for common TCA patterns.

## Example 1: Basic List Feature with Detail Navigation

A complete feature showing list display with drill-down navigation.

```swift
import ComposableArchitecture
import SwiftUI

@Reducer
public struct ItemsFeature: Sendable {
    // MARK: - Destination (Unified pattern for modals)

    @Reducer
    public enum Destination: Sendable {
        case addItem(AddItemFeature)
    }

    // MARK: - Path (Stack navigation for drill-down)

    @Reducer
    public enum Path: Sendable {
        case detail(ItemDetailFeature)
    }

    // MARK: - State

    @ObservableState
    public struct State: Equatable {
        @ObservationStateIgnored
        @Fetch
        public var data = ItemsRequest.Value()

        public var path = StackState<Path.State>()

        @Presents
        public var destination: Destination.State?

        public var isLoading = false

        public init() {}

        public static func == (lhs: State, rhs: State) -> Bool {
            lhs.data.items == rhs.data.items &&
            lhs.isLoading == rhs.isLoading &&
            lhs.path == rhs.path
        }
    }

    // MARK: - Action

    public enum Action: Sendable {
        case onAppear
        case addButtonTapped
        case itemTapped(Item)

        case loadItemsRequest
        case loadItemsResponse(Result<Void, Error>)

        case prepareDetailNavigation(Item)
        case detailNavigationReady(Result<ItemDetailFeature.State, Error>)

        case path(StackActionOf<Path>)
        case destination(PresentationAction<Destination.Action>)
    }

    // MARK: - Reducer

    public init() {}

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case .onAppear:
                return .send(.loadItemsRequest)

            case .loadItemsRequest:
                state.isLoading = true
                return .run(name: "LoadItems") { [data = state.$data] send in
                    await send(.loadItemsResponse(
                        Result { try await data.load(ItemsRequest(), animation: .default) }
                    ))
                }

            case .loadItemsResponse(.success):
                state.isLoading = false
                return .none

            case .loadItemsResponse(.failure(let error)):
                state.isLoading = false
                Logger.ui.error("Failed to load items: \(error)")
                return .none

            case .addButtonTapped:
                state.destination = .addItem(AddItemFeature.State())
                return .none

            case .itemTapped(let item):
                return .send(.prepareDetailNavigation(item))

            case .prepareDetailNavigation(let item):
                // Preload detail state before navigation (jank-free)
                return .run(name: "PrepareDetail") { send in
                    await send(.detailNavigationReady(
                        Result { try await ItemDetailFeature.preload(item: item) }
                    ))
                }

            case .detailNavigationReady(.success(let childState)):
                state.path.append(.detail(childState))
                return .none

            case .detailNavigationReady(.failure(let error)):
                Logger.ui.error("Failed to prepare detail: \(error)")
                return .none

            case .path(.element(id: _, action: .detail(.delegate(.itemDeleted)))):
                // Handle child delegate action
                _ = state.path.popLast()
                return .send(.loadItemsRequest)

            case .path:
                return .none

            case .destination(.presented(.addItem(.delegate(.itemCreated)))):
                state.destination = nil
                return .send(.loadItemsRequest)

            case .destination:
                return .none
            }
        }
        .forEach(\.path, action: \.path)
        .ifLet(\.$destination, action: \.destination)
    }
}

// MARK: - View

public struct ItemsView: View {
    @Bindable var store: StoreOf<ItemsFeature>

    public init(store: StoreOf<ItemsFeature>) {
        self.store = store
    }

    public var body: some View {
        NavigationStack(path: $store.scope(state: \.path, action: \.path)) {
            List {
                ForEach(store.data.items) { item in
                    Button { store.send(.itemTapped(item)) } label: {
                        ItemRowView(item: item)
                    }
                }
            }
            .navigationTitle("Items")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { store.send(.addButtonTapped) } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .onAppear { store.send(.onAppear) }
        } destination: { store in
            switch store.case {
            case .detail(let store):
                ItemDetailView(store: store)
            }
        }
        .sheet(item: $store.scope(state: \.destination?.addItem, action: \.destination.addItem)) { store in
            NavigationStack {
                AddItemView(store: store)
            }
        }
    }
}
```

## Example 2: Form Feature with BindableAction

A feature for editing data with two-way binding.

```swift
import ComposableArchitecture
import SwiftUI

@Reducer
public struct EditItemFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        public var item: Item
        public var name: String
        public var description: String
        public var isEnabled: Bool
        public var isSaving = false

        public init(item: Item) {
            self.item = item
            self.name = item.name
            self.description = item.description
            self.isEnabled = item.isEnabled
        }
    }

    public enum Action: BindableAction, Sendable {
        case binding(BindingAction<State>)
        case saveButtonTapped
        case saveResponse(Result<Void, Error>)
        case delegate(Delegate)

        public enum Delegate: Equatable, Sendable {
            case dismiss
            case itemUpdated(Item)
        }
    }

    @Dependency(\.itemService) var itemService
    @Dependency(\.dismiss) var dismiss

    public init() {}

    public var body: some Reducer<State, Action> {
        BindingReducer()  // MUST be first for BindableAction

        Reduce { state, action in
            switch action {
            case .binding:
                return .none  // Bindings update state automatically

            case .saveButtonTapped:
                state.isSaving = true
                let updatedItem = Item(
                    id: state.item.id,
                    name: state.name,
                    description: state.description,
                    isEnabled: state.isEnabled
                )
                return .run(name: "SaveItem") { [itemService] send in
                    await send(.saveResponse(
                        Result { try await itemService.update(updatedItem) }
                    ))
                }

            case .saveResponse(.success):
                state.isSaving = false
                return .run { _ in await dismiss() }

            case .saveResponse(.failure(let error)):
                state.isSaving = false
                Logger.ui.error("Save failed: \(error)")
                return .none

            case .delegate:
                return .none
            }
        }
    }
}

public struct EditItemView: View {
    @Bindable var store: StoreOf<EditItemFeature>

    public var body: some View {
        Form {
            Section("Details") {
                TextField("Name", text: $store.name)
                TextField("Description", text: $store.description)
                Toggle("Enabled", isOn: $store.isEnabled)
            }
        }
        .navigationTitle("Edit Item")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { store.send(.saveButtonTapped) }
                    .disabled(store.isSaving)
            }
        }
    }
}
```

## Example 3: Child Feature with Delegate Pattern

A child feature that communicates with its parent via delegates.

```swift
import ComposableArchitecture
import SwiftUI

@Reducer
public struct AddItemFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        public var name = ""
        public var description = ""
        public var isSaving = false

        public init() {}
    }

    public enum Action: BindableAction, Sendable {
        case binding(BindingAction<State>)
        case cancelButtonTapped
        case createButtonTapped
        case createResponse(Result<Item, Error>)
        case delegate(Delegate)

        public enum Delegate: Equatable, Sendable {
            case dismiss
            case itemCreated(Item)
        }
    }

    @Dependency(\.itemService) var itemService
    @Dependency(\.dismiss) var dismiss

    public init() {}

    public var body: some Reducer<State, Action> {
        BindingReducer()

        Reduce { state, action in
            switch action {
            case .binding:
                return .none

            case .cancelButtonTapped:
                return .run { _ in await dismiss() }

            case .createButtonTapped:
                state.isSaving = true
                let newItem = Item(name: state.name, description: state.description)
                return .run(name: "CreateItem") { [itemService] send in
                    await send(.createResponse(
                        Result { try await itemService.create(newItem) }
                    ))
                }

            case .createResponse(.success(let item)):
                state.isSaving = false
                // Notify parent before dismissing
                return .concatenate(
                    .send(.delegate(.itemCreated(item))),
                    .run { _ in await dismiss() }
                )

            case .createResponse(.failure(let error)):
                state.isSaving = false
                Logger.ui.error("Create failed: \(error)")
                return .none

            case .delegate:
                return .none  // Parent handles
            }
        }
    }

    // MARK: - Preloading

    /// Call before presenting to preload any required data
    nonisolated public static func preload() async throws -> State {
        // For simple features, just return initial state
        // For complex features, load data here
        return State()
    }
}

public struct AddItemView: View {
    @Bindable var store: StoreOf<AddItemFeature>

    public var body: some View {
        Form {
            Section("New Item") {
                TextField("Name", text: $store.name)
                TextField("Description", text: $store.description)
            }
        }
        .navigationTitle("Add Item")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { store.send(.cancelButtonTapped) }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Create") { store.send(.createButtonTapped) }
                    .disabled(store.name.isEmpty || store.isSaving)
            }
        }
    }
}
```

## Example 4: Service Layer Pattern

How to create a service that coordinates database writes and side effects.

```swift
import Dependencies
import GRDB

public struct ItemService: Sendable {
    public var create: @Sendable (_ item: Item) async throws -> Item
    public var update: @Sendable (_ item: Item) async throws -> Void
    public var delete: @Sendable (Item.ID) async throws -> Void
}

extension ItemService: DependencyKey {
    public static let liveValue: ItemService = {
        @Dependency(\.defaultDatabase) var database
        @Dependency(\.widgetCenter) var widgetCenter

        return ItemService(
            create: { item in
                try database.write { db in
                    var newItem = item
                    try newItem.insert(db)
                    Logger.data.debug("Created item: \(newItem.id)")
                    return newItem
                }
                await widgetCenter.reloadAllTimelines()
            },
            update: { item in
                try database.write { db in
                    try item.update(db)
                    Logger.data.debug("Updated item: \(item.id)")
                }
                await widgetCenter.reloadAllTimelines()
            },
            delete: { id in
                try database.write { db in
                    _ = try Item.deleteOne(db, id: id)
                    Logger.data.debug("Deleted item: \(id)")
                }
                await widgetCenter.reloadAllTimelines()
            }
        )
    }()
}

extension DependencyValues {
    public var itemService: ItemService {
        get { self[ItemService.self] }
        set { self[ItemService.self] = newValue }
    }
}
```

## Example 5: Root Coordinator Feature

A root feature that coordinates multiple child features.

```swift
import ComposableArchitecture
import SwiftUI

@Reducer
public struct AppFeature: Sendable {
    @ObservableState
    public struct State: Equatable {
        public var items = ItemsFeature.State()
        public var settings = SettingsFeature.State()
        public var selectedTab: Tab = .items

        @Presents
        public var addItem: AddItemFeature.State?

        public enum Tab: Equatable, Sendable {
            case items
            case settings
        }
    }

    public enum Action: Sendable {
        case items(ItemsFeature.Action)
        case settings(SettingsFeature.Action)
        case tabSelected(State.Tab)
        case addItem(PresentationAction<AddItemFeature.Action>)
    }

    public init() {}

    public var body: some Reducer<State, Action> {
        // Scope child features
        Scope(state: \.items, action: \.items) {
            ItemsFeature()
        }
        Scope(state: \.settings, action: \.settings) {
            SettingsFeature()
        }

        Reduce { state, action in
            switch action {
            case .tabSelected(let tab):
                state.selectedTab = tab
                return .none

            // Route delegate actions from ItemsFeature
            case .items(.delegate(.showAddItem)):
                state.addItem = AddItemFeature.State()
                return .none

            case .addItem(.presented(.delegate(.itemCreated))):
                state.addItem = nil
                return .send(.items(.loadItemsRequest))

            case .items, .settings, .addItem:
                return .none
            }
        }
        .ifLet(\.$addItem, action: \.addItem) {
            AddItemFeature()
        }
    }
}

public struct AppView: View {
    @Bindable var store: StoreOf<AppFeature>

    public var body: some View {
        TabView(selection: $store.selectedTab.sending(\.tabSelected)) {
            ItemsView(store: store.scope(state: \.items, action: \.items))
                .tag(AppFeature.State.Tab.items)
                .tabItem { Label("Items", systemImage: "list.bullet") }

            SettingsView(store: store.scope(state: \.settings, action: \.settings))
                .tag(AppFeature.State.Tab.settings)
                .tabItem { Label("Settings", systemImage: "gear") }
        }
        .sheet(item: $store.scope(state: \.addItem, action: \.addItem)) { store in
            NavigationStack {
                AddItemView(store: store)
            }
        }
    }
}
```
