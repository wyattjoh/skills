// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates how the reference app wires its persistence engine into the TCA dependency system: it
// sets the SQLiteData-provided `defaultDatabase` (and, when sync is enabled, `defaultSyncEngine`
// with the CloudKit-synced tables) as DependencyValues at app launch. Reducers/services then read
// `@Dependency(\.defaultDatabase)` — the database is a dependency, never a global singleton.

import Dependencies
import Foundation
import Sharing
import SQLiteData

extension DependencyValues {
    /// Build the database (and optional CloudKit sync engine) and install them as dependencies.
    public mutating func bootstrapDatabase() throws {
        // Open the database + run migrations, then publish it as a dependency value.
        defaultDatabase = try appDatabase()

        // Only stand up CloudKit sync when the user has enabled it (eventual consistency; never
        // block local writes on sync).
        @Shared(.isSyncEnabled) var isSyncEnabled
        if isSyncEnabled {
            defaultSyncEngine = try SyncEngine(
                for: defaultDatabase,
                tables: Note.self, Folder.self,
                privateTables: Tag.self
            )
        }
    }
}
