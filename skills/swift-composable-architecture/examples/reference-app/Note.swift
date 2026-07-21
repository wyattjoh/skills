// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates the reference app's persistence MODEL: a plain Swift VALUE TYPE annotated with
// SQLiteData's `@Table` macro (backed by GRDB). Because the row type is already a `struct` that is
// Sendable/Equatable, it drops straight into @ObservableState with NO translation layer — that is
// the whole reason the reference app's reducers stay clean. A persistence engine whose row types are
// reference types (not Sendable) would instead need a value-type snapshot in TCA state.

import Foundation
import SQLiteData
import SwiftUI

@Table
public nonisolated struct Note: Identifiable, Sendable, Equatable, Hashable {
    public let id: UUID

    public var title: String
    @Column(as: Color.HexRepresentation.self)
    public var color: Color = Self.defaultColor
    public var body: String
    public var isPinned: Bool
    public var updatedAt: Date?

    // Optional FK to another table's row (a value-type id, not an object reference).
    public var folderID: Folder.ID?

    public nonisolated static var defaultColor: Color {
        Color(red: 15 / 255.0, green: 75 / 255.0, blue: 129 / 255.0)
    }

    public init(
        id: UUID = UUID(),
        title: String,
        color: Color = Self.defaultColor,
        body: String,
        isPinned: Bool = false,
        updatedAt: Date? = nil,
        folderID: Folder.ID? = nil
    ) {
        self.id = id
        self.title = title
        self.color = color
        self.body = body
        self.isPinned = isPinned
        self.updatedAt = updatedAt
        self.folderID = folderID
    }
}

// @Table also generates a `Draft` type for inserts that don't yet have server-assigned fields.
nonisolated extension Note.Draft: Identifiable, Sendable, Equatable {}
