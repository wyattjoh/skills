// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates: @Reducer + @ObservableState, BindableAction + BindingReducer, @Dependency,
// an inline @Dependency(\.defaultDatabase) read inside an effect, a named .run effect, an
// AlertState destination via @Presents/ifLet, and a delegate action to talk to the parent.
// The reference app persists with SQLiteData (\.defaultDatabase). The TCA shape here (BindingReducer,
// .run, save/response, alert, delegate) is what a typical detail/editor reducer looks like.

import ComposableArchitecture
import Foundation

@Reducer
public struct EditNoteFeature {
    @ObservableState
    public struct State: Equatable, Sendable {
        public var note: Note
        public let folder: Folder
        public var tags: [Tag] = []

        public var isSaving = false
        public var isDeleting = false
        public var showingDeleteConfirmation = false

        @Presents
        public var alert: AlertState<Action.Alert>?

        public var isValid: Bool { !note.title.isEmpty }

        public init(note: Note, folder: Folder, tags: [Tag] = []) {
            self.note = note
            self.folder = folder
            self.tags = tags
        }
    }

    public enum Action: BindableAction, Sendable {
        // Form fields bind here; BindingReducer applies them.
        case binding(BindingAction<State>)

        case onAppear
        case tagsLoaded([Tag])

        case saveButtonTapped
        case deleteButtonTapped
        case deleteConfirmed

        case saveResponse(Result<Void, Error>)
        case deleteResponse(Result<Void, Error>)

        case alert(PresentationAction<Alert>)
        case delegate(Delegate)

        public enum Alert: Equatable, Sendable { case dismiss }
        public enum Delegate: Equatable, Sendable { case dismiss }
    }

    @Dependency(\.noteService) var noteService
    @Dependency(\.dismiss) var dismiss

    public init() {}

    public var body: some Reducer<State, Action> {
        BindingReducer()

        Reduce { state, action in
            switch action {
            case .onAppear:
                let folderID = state.folder.id
                // An effect can read the persistence dependency inline.
                return .run { send in
                    @Dependency(\.defaultDatabase) var database
                    let tags = try await database.read { db in
                        try Tag
                            .where { $0.folderID.eq(folderID) }
                            .fetchAll(db)
                    }
                    await send(.tagsLoaded(tags))
                }

            case let .tagsLoaded(tags):
                state.tags = tags
                return .none

            case .binding:
                // Field edits handled by BindingReducer above.
                return .none

            case .saveButtonTapped:
                state.isSaving = true
                return .run(name: "UpdateNote") { [note = state.note, noteService] send in
                    await send(.saveResponse(Result { try await noteService.update(note) }))
                }

            case .saveResponse(.success):
                state.isSaving = false
                return .run { [dismiss] _ in await dismiss() }

            case let .saveResponse(.failure(error)):
                state.isSaving = false
                // Surface the error to the user instead of failing silently.
                state.alert = AlertState {
                    TextState("Error Updating Note")
                } actions: {
                    ButtonState(role: .cancel, action: .send(.dismiss)) { TextState("OK") }
                } message: {
                    TextState(error.localizedDescription)
                }
                return .none

            case .deleteButtonTapped:
                state.showingDeleteConfirmation = true
                return .none

            case .deleteConfirmed:
                state.showingDeleteConfirmation = false
                state.isDeleting = true
                return .run(name: "DeleteNote") { [noteService, id = state.note.id] send in
                    await send(.deleteResponse(Result { try await noteService.delete(id: id) }))
                }

            case .deleteResponse(.success):
                state.isDeleting = false
                return .run { [dismiss] _ in await dismiss() }

            case .deleteResponse(.failure):
                state.isDeleting = false
                return .none

            case .alert, .delegate:
                return .none
            }
        }
        .ifLet(\.$alert, action: \.alert)
    }
}
