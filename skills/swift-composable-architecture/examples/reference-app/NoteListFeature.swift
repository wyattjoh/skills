// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates:
//   - REACTIVE READS: an `@ObservationStateIgnored @Fetch` property in state whose FetchKeyRequest
//     runs a query and is re-emitted when underlying data changes (SQLiteData's auto-observe)
//   - a custom Equatable on State (needed because @Fetch isn't synthesizable)
//   - CANCELLATION: a private `CancelID` enum + `.cancellable(id:cancelInFlight:)`
//   - @Shared user preference used directly in state
//
// @Fetch auto-updates because SQLiteData re-emits when the underlying tables change. The
// cancellation + .run pattern below shows how a new effect supersedes an in-flight request on re-tap.

import ComposableArchitecture
import Foundation

@Reducer
public struct NoteListFeature: Sendable {
    public init() {}

    // Stable identifiers so a new effect can cancel the previous one.
    private enum CancelID: Hashable {
        case saveNote
        case prepareNavigation
    }

    @ObservableState
    public struct State: Equatable, Sendable {
        // Reactive data: re-emitted when the query's tables change.
        @ObservationStateIgnored
        @Fetch public var data = NoteListRequest.Value()
        public var isLoadingData = false
        public var isSaving = false

        // A persisted user preference participates in state directly.
        @Shared(.noteSortOption)
        public var sortOption = NoteSortOption.recency

        public var notes: [Note] { data.notes }

        // Hand-written == because @Fetch can't be auto-synthesized.
        public static func == (lhs: State, rhs: State) -> Bool {
            lhs.data.notes == rhs.data.notes
                && lhs.isLoadingData == rhs.isLoadingData
                && lhs.isSaving == rhs.isSaving
                && lhs.sortOption == rhs.sortOption
        }

        public nonisolated init() {}
    }

    public enum Action: Sendable {
        case pinnedNoteTapped(note: Note)
        case saveResponse(Result<Void, Error>)
        case delegate(Delegate)
        public enum Delegate: Equatable, Sendable { case dismiss }
    }

    @Dependency(\.noteService) var noteService

    public var body: some Reducer<State, Action> {
        Reduce { state, action in
            switch action {
            case let .pinnedNoteTapped(note):
                state.isSaving = true
                // A named, cancellable effect; a re-tap cancels the in-flight save.
                return .run(name: "SaveNote") { [noteService, noteID = note.id] send in
                    await send(.saveResponse(Result {
                        try await noteService.togglePin(noteID: noteID)
                    }))
                }
                .cancellable(id: CancelID.saveNote, cancelInFlight: true)

            case .saveResponse(.success):
                state.isSaving = false
                return .send(.delegate(.dismiss))

            case .saveResponse(.failure):
                state.isSaving = false
                return .none

            case .delegate:
                return .none
            }
        }
    }
}

// MARK: - Reactive query (FetchKeyRequest)

// The request runs SQL and returns a Sendable Value; SQLiteData re-runs it when tables change.
public nonisolated struct NoteListRequest: FetchKeyRequest {
    public struct Value: Sendable {
        public var notes: [Note] = []
    }

    public func fetch(_ db: Database) throws -> Value {
        let notes = try Note
            .order { ($0.updatedAt.desc(), $0.title.asc()) }
            .fetchAll(db)
        return Value(notes: notes)
    }
}
