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
                        tellFilesApp() // may have missed changes while the stream was down
                        connectedBefore = true
                    }
                }) { ev in
                    DispatchQueue.main.async {
                        tellFilesApp()
                        NotificationCenter.default.post(name: .cloudyChange, object: ev)
                    }
                }
            } catch let e as APIError where e.status == 401 || e.status == 404 {
                return // signed out, or a server without live updates
            } catch {
                // network error: retry below
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    @MainActor private static var lastSignal = Date.distantPast
    @MainActor private static var signalPending = false

    /// Asks the Files extension to look for changes, at most once every 5 seconds: each signal makes it walk the
    /// account's folders, and an upload of many files sends an event per file. An event that arrives inside the
    /// 5 seconds is not lost: one signal goes out when they are over.
    @MainActor private static func tellFilesApp() {
        let wait = 5 - Date().timeIntervalSince(lastSignal)
        if wait <= 0 {
            lastSignal = Date()
            FilesDomain.changed()
        } else if !signalPending {
            signalPending = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(wait))
                signalPending = false
                lastSignal = Date()
                FilesDomain.changed()
            }
        }
    }
}

/// Downloaded copies for preview and sharing, in Caches (the system may purge them).
/// Keyed by node id + etag so a changed file is fetched again. Each copy sits in its own folder, whose modification
/// date is the last time the copy was opened (`prune` goes by it).
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
        if fm.fileExists(atPath: dest.path) {
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.deletingLastPathComponent().path)
            return dest
        }
        try await API.shared.download(node.id, to: dest)
        // Older versions of this file (other etags) are not needed any more.
        let keep = dest.deletingLastPathComponent().lastPathComponent
        for dir in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where dir.hasPrefix("\(node.id)-") && dir != keep {
            try? fm.removeItem(at: root.appendingPathComponent(dir))
        }
        return dest
    }

    static func clear() { try? FileManager.default.removeItem(at: root) }

    /// At launch, off the main thread: copies not opened for 14 days go, and beyond 500 MB in total the ones opened
    /// longest ago. Every opened or exported file and folder ZIP used to stay until sign-out.
    static func pruneInBackground() {
        Task.detached(priority: .utility) { prune() }
    }

    static func prune(maxAge: TimeInterval = 14 * 86_400, maxBytes: Int64 = 500_000_000, now: Date = Date()) {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        var kept: [(dir: URL, used: Date, bytes: Int64)] = []
        for dir in dirs {
            let used = (try? dir.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if now.timeIntervalSince(used) > maxAge {
                try? fm.removeItem(at: dir)
                continue
            }
            var bytes: Int64 = 0
            for file in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? [] {
                bytes += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
            }
            kept.append((dir, used, bytes))
        }
        var total = kept.reduce(0) { $0 + $1.bytes }
        // Oldest first. A copy from the last minutes stays whatever its size: it may be opening right now.
        for entry in kept.sorted(by: { $0.used < $1.used }) where total > maxBytes && now.timeIntervalSince(entry.used) > 600 {
            try? fm.removeItem(at: entry.dir)
            total -= entry.bytes
        }
    }

    /// A scratch file for uploads/exports in tmp (cleaned by the system). `name` may come from the server
    /// (an address book's name for the export), so it is made a single safe path component.
    static func tempURL(_ name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(safeFileName(name), isDirectory: false)
    }
}
