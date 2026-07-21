// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates how the root view wires TREE-BASED navigation from a coordinator store:
//   - the always-present child is shown via `store.scope(state:action:)`
//   - each presented destination is a `.sheet(item: $store.scope(state:action:))` driven off the
//     optional Destination case, so SwiftUI presents/dismisses in lockstep with reducer state
//
// A deep link sets the destination in the reducer and the corresponding sheet appears automatically.

import ComposableArchitecture
import NotesFeatures
import SwiftUI

struct RootView: View {
    @Bindable
    var store: StoreOf<RootFeature>

    var body: some View {
        // The non-optional child list.
        NoteListView(store: store.scope(state: \.noteList, action: \.noteList))
            // Each presented destination, keyed off its Destination case.
            .modifier(AddNoteSheet(store: store))
            .modifier(EditNoteSheet(store: store))
            .modifier(SettingsSheet(store: store))
    }
}

private struct AddNoteSheet: ViewModifier {
    @Bindable var store: StoreOf<RootFeature>

    func body(content: Content) -> some View {
        content.sheet(
            // Present only when destination == .addNote; bind the scoped child store.
            item: $store.scope(
                state: \.destination?.addNote,
                action: \.destination.addNote
            )
        ) { addStore in
            NavigationStack {
                NoteEditorView(store: addStore)
            }
        }
    }
}

private struct EditNoteSheet: ViewModifier {
    @Bindable var store: StoreOf<RootFeature>

    func body(content: Content) -> some View {
        content.sheet(
            item: $store.scope(
                state: \.destination?.editNote,
                action: \.destination.editNote
            )
        ) { editStore in
            EditNoteView(store: editStore)
        }
    }
}

private struct SettingsSheet: ViewModifier {
    @Bindable var store: StoreOf<RootFeature>

    func body(content: Content) -> some View {
        content.sheet(
            item: $store.scope(
                state: \.destination?.settings,
                action: \.destination.settings
            )
        ) { settingsStore in
            SettingsView(store: settingsStore)
        }
    }
}
