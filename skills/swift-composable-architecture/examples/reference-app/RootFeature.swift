// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates the root COORDINATOR pattern with TREE-BASED navigation:
//   - a `@Reducer enum Destination` groups mutually-exclusive child features into one optional slot
//   - `@Presents var destination` holds at most one presented child
//   - `Scope(state:action:)` embeds a non-optional child (the always-present main list)
//   - the parent reads child `.delegate` actions to drive navigation (set/clear `state.destination`)
//   - a single `.ifLet(\.$destination, action: \.destination)` runs whichever child is active
//
// The reference app is 100% tree-based (no NavigationStack/StackState). For a drill-down stack you
// would use StackState (see TCA's 04-NavigationStack case study). A deep link sets the destination
// here, the same way a delegate does.

import ComposableArchitecture
import Foundation

@Reducer
public struct RootFeature {
    // Each case is a full child reducer; @Reducer on the enum composes them.
    @Reducer
    public enum Destination {
        case noteHistory(HistoryFeature)
        case addNote(NoteEditorFeature)
        case editNote(EditNoteFeature)
        case settings(SettingsFeature)
    }

    @ObservableState
    public struct State {
        public var noteList = NoteListFeature.State()   // always-present main list
        @Presents public var destination: Destination.State?

        public init(
            noteList: NoteListFeature.State = NoteListFeature.State(),
            destination: Destination.State? = nil
        ) {
            self.noteList = noteList
            self.destination = destination
        }
    }

    public enum Action {
        case noteList(NoteListFeature.Action)
        case destination(PresentationAction<Destination.Action>)
    }

    public init() {}

    public var body: some Reducer<State, Action> {
        // Compose the non-optional child.
        Scope(state: \.noteList, action: \.noteList) {
            NoteListFeature()
        }

        Reduce { state, action in
            switch action {
            // A child delegate action asks the coordinator to present something.
            case let .noteList(.delegate(.showEditNote(note))):
                state.destination = .editNote(EditNoteFeature.State(note: note, folder: note.folder))
                return .none

            case .noteList(.delegate(.showAddNote)):
                state.destination = .addNote(NoteEditorFeature.State())
                return .none

            case .noteList(.delegate(.showSettings)):
                state.destination = .settings(SettingsFeature.State())
                return .none

            case .noteList:
                return .none

            // A presented child finished: clear the slot, and optionally react.
            case .destination(.presented(.addNote(.delegate(.noteCreated)))):
                state.destination = nil
                return .send(.noteList(.loadNotesRequest))   // refresh the list

            case .destination(.presented(.editNote(.delegate(.noteUpdated)))):
                state.destination = nil
                return .send(.noteList(.loadNotesRequest))

            case .destination:
                return .none
            }
        }
        // Runs whichever Destination case is currently presented.
        .ifLet(\.$destination, action: \.destination)
    }
}
