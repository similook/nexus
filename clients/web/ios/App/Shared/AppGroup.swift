import Foundation

/// The App Group the app and the packet-tunnel extension share (ios-plan/phase2-design.md).
///
/// Paths follow sing-box for Apple (FilePath.swift), so libbox finds what it expects:
///   base    = the group container root - libbox puts the command socket here (command.sock)
///   working = Library/Caches/Working   - cache.db (fake-IP table, store_fakeip) and core state
///   temp    = Library/Caches
/// Both processes call nexuscore's Setup with these same three paths: the app to reach the
/// extension's command server, the extension to run it.
enum AppGroup {
    static let identifier = "group.io.nexus.app"

    static var containerURL: URL {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
            // Only when the App Groups entitlement is missing from the target: a build error in
            // disguise, never a runtime condition to recover from.
            fatalError("App Group \(identifier) is not configured for this target")
        }
        return url
    }

    static var basePath: String { containerURL.path }
    static var tempPath: String { containerURL.appendingPathComponent("Library/Caches", isDirectory: true).path }
    static var workingPath: String {
        containerURL.appendingPathComponent("Library/Caches/Working", isDirectory: true).path
    }

    /// Creates the working and temp directories. Idempotent; call before Setup.
    static func prepareDirectories() throws {
        for path in [tempPath, workingPath] {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        }
    }
}
