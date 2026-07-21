// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral "notes"
// example; the structure and APIs are faithful to the original.
// Illustrates `@Shared` user-preference keys: type-safe extensions on `SharedReaderKey` over
// `.appStorage`, so features write `@Shared(.hidePreviewText) var hidePreviewText = false`
// and mutate with `state.$hidePreviewText.withLock { $0 = true }` (1.26.0 requires withLock).
// Use this for DEVICE-LOCAL user preferences only; domain data belongs in the persistence layer.

import Foundation
import Sharing

/// A central enum of preference keys whose raw value IS the UserDefaults key string. CaseIterable
/// lets a "reset all" wipe them in one pass.
public enum UserPreferenceKey: String, CaseIterable, Sendable {
    case hasCompletedOnboarding
    case hidePreviewText
    case noteSortOption

    public static func resetAll(in store: UserDefaults = .standard) {
        for key in allCases { store.removeObject(forKey: key.rawValue) }
    }
}

// Type-safe Bool preference keys. `.Default` bakes in the default value so call sites never repeat it.
extension SharedReaderKey where Self == AppStorageKey<Bool>.Default {
    private static func boolKey(_ key: UserPreferenceKey) -> Self {
        Self[.appStorage(key.rawValue), default: false]
    }

    public static var hasCompletedOnboarding: Self { boolKey(.hasCompletedOnboarding) }
    public static var hidePreviewText: Self { boolKey(.hidePreviewText) }
}

// A non-Bool enum preference, stored device-local, never synced.
public enum AppearanceMode: String, CaseIterable, Sendable, Codable {
    case system
    case light
    case dark
}

extension SharedReaderKey where Self == AppStorageKey<AppearanceMode>.Default {
    public static var appearanceMode: Self {
        Self[.appStorage("appearanceMode"), default: .system]
    }
}

// Usage in a reducer:
//
//   @ObservableState struct State {
//       @Shared(.hidePreviewText) var hidePreviewText = false
//   }
//
//   case .previewToggled(let on):
//       state.$hidePreviewText.withLock { $0 = on }   // mutate via withLock
//       return .none
