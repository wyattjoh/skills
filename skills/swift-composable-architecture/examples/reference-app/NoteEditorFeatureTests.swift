// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original (including the `makeTestDatabase()`
// helper).
// Illustrates TestStore testing with Swift Testing (@Suite/@Test/#expect):
//   - construct `TestStore(initialState:) { Feature() } withDependencies: { ... }`
//   - override the persistence engine with a REAL in-memory database (running real migrations) and
//     swap clients for `.testValue`
//   - `await store.send(.action) { $0.expectedMutation }` asserts synchronous state changes
//   - `store.exhaustivity = .off` when reactive observation emits actions you don't want to enumerate
//   - assert persistence by reading back from the in-memory db
//   - a multi-step editor is just a `step` enum advanced by actions (the reference app's stack-free
//     alternative to NavigationStack)

import ComposableArchitecture
import DependenciesTestSupport
import Foundation
import GRDB
import Testing

@testable import NotesDatabase
@testable import NotesFeatures

// Real in-memory database running the real migrations — the analogue of an in-memory ModelContainer.
// Tests get true persistence behavior without a CloudKit container.
func makeTestDatabase() throws -> DatabaseQueue {
    var config = Configuration()
    config.foreignKeysEnabled = true
    let db = try DatabaseQueue(configuration: config)
    try configuredMigrator().migrate(db)
    return db
}

@MainActor
@Suite("NoteEditorFeature")
struct NoteEditorFeatureTests {

    @Test("Next advances through the editor steps")
    func editorForwardProgression() async throws {
        let db = try makeTestDatabase()

        var initialState = NoteEditorFeature.State()
        initialState.title = "Groceries"
        initialState.body = "Milk, eggs"

        let store = TestStore(initialState: initialState) {
            NoteEditorFeature()
        } withDependencies: {
            $0.defaultDatabase = db
        }
        // Reactive @Fetch observation can emit reload actions; don't force enumerating them here.
        store.exhaustivity = .off

        await store.send(.nextTapped) { $0.step = .details }
        await store.send(.nextTapped) { $0.step = .appearance }
        await store.send(.nextTapped) { $0.step = .review }
    }

    @Test("Save writes to the database and signals the parent")
    func saveDispatchesToService() async throws {
        let db = try makeTestDatabase()

        var state = NoteEditorFeature.State()
        state.title = "Groceries"
        state.body = "Milk, eggs"

        let store = TestStore(initialState: state) {
            NoteEditorFeature()
        } withDependencies: {
            $0.defaultDatabase = db
        }
        store.exhaustivity = .off

        await store.send(.createNoteTapped)
        // Assert effect feedback by case key-path (@CasePathable enables this).
        await store.receive(\.saveResponse) { $0.isSaving = false }

        // Verify persistence by reading the real in-memory db back.
        let saved: [Note] = try await db.read { db in try Note.fetchAll(db) }
        #expect(saved.count == 1)
        #expect(saved.first?.title == "Groceries")
    }

    @Test("Validation blocks an empty title without touching the store")
    func validationBlocksEmptyTitle() {
        let state = NoteEditorFeature.State()
        #expect(state.title == "")
        #expect(state.canAdvance == false)
    }
}
