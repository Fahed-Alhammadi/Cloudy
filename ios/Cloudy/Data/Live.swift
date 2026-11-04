import Foundation

extension Notification.Name {
    /// Posted on the main thread with a `ChangeEvent` as `object`.
    static let cloudyChange = Notification.Name("cloudyChange")
    /// Posted on the main thread when the live-update stream reconnected: changes made while it was down
    /// (app in the background, network gone) were missed, so every screen reloads once.
    static let cloudyResync = Notification.Name("cloudyResync")
}

/// Live updates: one Server-Sent Events stream while the app is in the foreground. Screens listen for
/// `.cloudyChange` and reload when their folder changed. Duplicate or early events just cause a reload.
enum Live {
    /// The first stream of this launch needs no resync: the screens have just loaded.
    @MainActor private static var connectedBefore = false

    /// Runs until the task is cancelled; reconnects after network errors.
    static func run() async {
        while !Task.isCancelled {
            do {
                try await API.shared.streamEvents(onOpen: {
                    Task { @MainActor in
                        if connectedBefore { NotificationCenter.default.post(name: .cloudyResync, object: nil) }
                        connectedBefore = true
                    }
                }) { ev in
                    DispatchQueue.main.async { NotificationCenter.default.post(name: .cloudyChange, object: ev) }
                }
            } catch let e as APIError where e.status == 401 || e.status == 404 {
                return // signed out, or a server without live updates
            } catch {
                // network error: retry below
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }
}

/// Downloaded copies for preview and sharing, in Caches (the system may purge them).
/// Keyed by node id + etag so a changed file is fetched again.
enum FileCache {
    static var root: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("files") }

    static func url(for node: FileNode) -> URL {
        let tag = safeToken(node.etag ?? "")
        let name = safeFileName(node.isDir ? node.name + ".zip" : node.name)
        return root.appendingPathComponent("\(node.id)-\(tag)", isDirectory: true).appendingPathComponent(name, isDirectory: false)
    }

    /// Returns a local copy, downloading it when missing.
    static func fetch(_ node: FileNode) async throws -> URL {
        let dest = url(for: node)
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) { return dest }
        try await API.shared.download(node.id, to: dest)
        // Older versions of this file (other etags) are not needed any more.
        let keep = dest.deletingLastPathComponent().lastPathComponent
        for dir in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where dir.hasPrefix("\(node.id)-") && dir != keep {
            try? fm.removeItem(at: root.appendingPathComponent(dir))
        }
        return dest
    }

    static func clear() { try? FileManager.default.removeItem(at: root) }

    /// A scratch file for uploads/exports in tmp (cleaned by the system). `name` may come from the server
    /// (an address book's name for the export), so it is made a single safe path component.
    static func tempURL(_ name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(safeFileName(name), isDirectory: false)
    }
}
