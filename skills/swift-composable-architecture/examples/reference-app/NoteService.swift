// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates the reference app's WRITE path: a service struct whose methods take
// `@Dependency(\.defaultDatabase)`, perform the write inside a single transaction (with a guard for
// referential integrity), then fire coalesced side effects. The service is registered as a
// dependency via the `@DependencyEntry` macro (bottom of file). Reducers call it from a `.run`
// effect (see EditNoteFeature.saveButtonTapped).

import Dependencies
import DependenciesMacros
import Foundation
import SQLiteData

public nonisolated struct NoteService: Sendable {
    public init() {}

    /// Create a note. The actual write goes through the database dependency; the service also
    /// coordinates side effects (search index, widgets) so reducers don't have to.
    public func create(folderID: Folder.ID, title: String, body: String = "") async throws {
        @Dependency(\.defaultDatabase) var database
        @Dependency(\.sideEffectCoordinator) var coordinator

        let draft = Note.Draft(folderID: folderID, title: title, body: body)

        // One transaction: verify the FK target exists, then insert. All-or-nothing.
        try await database.write { db in
            guard try Folder.find(folderID).fetchOne(db) != nil else {
                throw NoteServiceError.folderNotFound(folderID)
            }
            try Note.upsert { draft }.execute(db)
        }

        await coordinator.noteChange(folders: [folderID])
    }

    public func update(_ note: Note) async throws {
        @Dependency(\.defaultDatabase) var database
        @Dependency(\.sideEffectCoordinator) var coordinator

        try await database.write { db in
            try Note.update(note).execute(db)
        }
        await coordinator.noteChange(folders: [note.folderID].compactMap { $0 })
    }

    public func togglePin(noteID: Note.ID) async throws {
        @Dependency(\.defaultDatabase) var database
        try await database.write { db in
            try Note.update { $0.isPinned.toggle() }.where { $0.id.eq(noteID) }.execute(db)
        }
    }

    public func delete(id: Note.ID) async throws {
        @Dependency(\.defaultDatabase) var database
        try await database.write { db in
            try Note.delete().where { $0.id.eq(id) }.execute(db)
        }
    }
}

enum NoteServiceError: Error, CustomStringConvertible {
    case folderNotFound(Folder.ID)
    var description: String {
        switch self {
        case let .folderNotFound(id): "Folder not found: \(id)"
        }
    }
}

// MARK: - Dependency registration
// `@DependencyEntry` generates the DependencyValues plumbing for a plain service struct. (A
// struct-of-closures client can instead write the DependencyKey/DependencyValues by hand, which is
// the style to prefer for swappable seams.)
nonisolated extension DependencyValues {
    @DependencyEntry(liveValue: NoteService())
    public var noteService = NoteService()
}
