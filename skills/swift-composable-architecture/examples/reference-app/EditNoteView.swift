// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates the MODERN 1.26.0 view idiom: a SwiftUI view holds `@Bindable var store: StoreOf<...>`
// and reads/binds it directly — NO ViewStore / WithViewStore. Form controls bind with `$store.field`,
// actions are sent with `store.send(...)`, and a presented alert is wired with
// `$store.scope(state:action:)`.
//
// Structural note: the reference app keeps REDUCERS in an SPM package and VIEWS in the Xcode app
// target, importing the feature module. The per-feature view folders hold the views; the reducers
// live in (or are imported from) the model layer.

import ComposableArchitecture
import NotesFeatures
import SwiftUI

struct EditNoteView: View {
    @Bindable
    var store: StoreOf<EditNoteFeature>

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        List {
            Section {
                // Two-way binding straight to reducer state via $store.
                TextField("Title", text: $store.note.title)

                DatePicker(
                    "Updated",
                    selection: $store.note.updatedAt,
                    displayedComponents: [.date, .hourAndMinute]
                )
            } header: {
                Text("Note Details")
            }

            Section {
                Button(role: .destructive) {
                    store.send(.deleteButtonTapped)
                } label: {
                    Text("Delete Note").frame(maxWidth: .infinity)
                }
            }
        }
        .task { store.send(.onAppear) }
        .navigationTitle("Edit Note")
        .disabled(store.isSaving || store.isDeleting)
        // Present the alert destination from scoped store state.
        .alert($store.scope(state: \.alert, action: \.alert))
        .confirmationDialog(
            "Delete Note",
            isPresented: $store.showingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { store.send(.deleteConfirmed) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to delete this note? This cannot be undone.")
        }
    }
}
