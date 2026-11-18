import FileProvider
import Foundation
import os

/// Console.app / `log stream`: subsystem io.cloudy.app, category "files" (app side) or "provider" (extension).
let filesLog = Logger(subsystem: "io.cloudy.app", category: Bundle.main.bundleURL.pathExtension == "appex" ? "provider" : "files")

/// "Cloudy" under Locations in the Files app: one File Provider domain while signed in and the app lock is off
/// (`CloudyFiles` extension). The app adds it after sign-in or when the lock is turned off (and at every launch, a
/// no-op when it exists), removes it on sign-out or when the lock is turned on (with the copies iOS downloaded), and
/// tells the extension about server changes it hears over live updates.
enum FilesDomain {
    static let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("cloudy"), displayName: "Cloudy")

    /// Extension state in the App Group container (`Index`); removed with the domain so another account starts clean.
    static var stateDir: URL {
        (FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            ?? FileManager.default.temporaryDirectory).appendingPathComponent("FileProvider", isDirectory: true)
    }

    /// Adds and removes run one after another, so a quick sign-out + sign-in can't end with no domain.
    @MainActor private static var queue: Task<Void, Never>?

    @MainActor static func setAvailable(_ on: Bool) {
        let previous = queue
        queue = Task {
            await previous?.value
            do {
                #if DEBUG
                // Testing: `SIMCTL_CHILD_CLOUDY_FILES_RESET=1` starts the Files location from scratch.
                if on, ProcessInfo.processInfo.environment["CLOUDY_FILES_RESET"] != nil {
                    try await NSFileProviderManager.removeAllDomains()
                    try? FileManager.default.removeItem(at: stateDir)
                }
                #endif
                if on {
                    try await NSFileProviderManager.add(domain)
                } else {
                    try await NSFileProviderManager.removeAllDomains()
                    try? FileManager.default.removeItem(at: stateDir)
                }
            } catch {
                filesLog.error("Files location \(on ? "add" : "remove", privacy: .public) failed: \(error, privacy: .public)")
            }
        }
    }

    /// Something changed on the server: the extension compares the folders it has shown with the server's.
    static func changed() {
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { error in
            if let error { filesLog.debug("signalEnumerator: \(error, privacy: .public)") }
        }
    }
}
