// Adapted (trimmed) from a production TCA reference app. Domain renamed to a neutral example; the
// structure and APIs are faithful to the original.
// Illustrates the STRUCT-OF-CLOSURES dependency client: a `Sendable` struct whose properties are
// `@Sendable` async closures, conforming to `DependencyKey` with `liveValue` / `testValue` /
// `previewValue`, plus a `DependencyValues` computed property to access it.
//
// This is the shape to prefer for SWAPPABLE seams, because overriding one closure in a TestStore
// needs no subclass or mock type:
//   withDependencies: { $0.remoteConfig.fetch = { _ in .mock } }

import Dependencies
import Foundation

public enum FetchResult: Equatable, Sendable {
    case value(String)
    case unavailable(String)
}

public struct RemoteConfigClient: Sendable {
    public var fetch: @Sendable (_ key: String) async -> FetchResult

    public init(fetch: @Sendable @escaping (_ key: String) async -> FetchResult) {
        self.fetch = fetch
    }
}

extension RemoteConfigClient: DependencyKey {
    // Real implementation used in the running app.
    public static let liveValue = RemoteConfigClient(fetch: { key in
        do {
            let (data, _) = try await URLSession.shared.data(
                from: URL(string: "https://example.com/config/\(key)")!
            )
            return .value(String(decoding: data, as: UTF8.self))
        } catch {
            return .unavailable(error.localizedDescription)
        }
    })

    // Deterministic value for tests — no network, no I/O.
    public static let testValue = RemoteConfigClient(fetch: { _ in .value("test") })

    // Value for SwiftUI previews — simulate a short delay then succeed.
    public static let previewValue = RemoteConfigClient(fetch: { _ in
        try? await Task.sleep(for: .seconds(1))
        return .value("preview")
    })
}

extension DependencyValues {
    public var remoteConfig: RemoteConfigClient {
        get { self[RemoteConfigClient.self] }
        set { self[RemoteConfigClient.self] = newValue }
    }
}
