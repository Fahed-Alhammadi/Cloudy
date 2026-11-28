import CryptoKit
import FileProvider
import ImageIO
import UniformTypeIdentifiers

/// "Cloudy" in the Files app (NSFileProviderReplicatedExtension): every file listed, its contents downloaded when
/// opened, changes made in the Files app (or saved from other apps) sent to the server. Deletes go to the server's
/// trash. A file changed on both sides is uploaded as "name (conflicted copy <date>).ext", like the desktop app.
/// Ported from the macOS Cloudy Drive extension (removed 2026-11-02).
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension, NSFileProviderThumbnailing {
    /// iOS also runs the extension for a hidden "default" domain of its own. It shows as "Cloudy" while signed out
    /// (with "Authentication Required — Open Cloudy"), so it must never list or store anything: all work happens in
    /// the domain the app adds (`FilesDomain`), which has its own state.
    private let isOurs: Bool

    required init(domain: NSFileProviderDomain) {
        isOurs = domain.identifier == FilesDomain.domain.identifier
        super.init()
        _ = Self.lowMemoryUploads
    }

    /// iOS gives extensions little memory: upload chunks are streamed from a file instead of held in memory. Set once
    /// per process, before any upload (several domain instances can share the process).
    private static let lowMemoryUploads: Void = { API.shared.chunksFromFile = true }()

    /// The system is done with this instance, often shortly before it ends the process: nothing may be left waiting.
    func invalidate() { Index.shared.flush() }

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        run(completionHandler) { try await Remote.item(identifier) }
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        guard isOurs else { throw NSFileProviderError(.notAuthenticated) }
        // iOS asks for a folder's enumerator each time the Files app opens it, but lists it from its own copy: the
        // moment to look for changes made elsewhere (no live updates reach the phone while the Cloudy app is closed).
        if containerItemIdentifier != .workingSet { Self.checkForChanges() }
        return Enumerator(containerItemIdentifier)
    }

    nonisolated(unsafe) private static var lastCheck = Date.distantPast
    private static let checkLock = NSLock()

    /// Asks the system to run the working-set change walk, at most every 15 seconds. The walk reads only folders whose
    /// etag moved, so an unchanged account costs two requests (root + "Shared with you").
    private static func checkForChanges() {
        let due = checkLock.withLock {
            guard Date().timeIntervalSince(lastCheck) > 15 else { return false }
            lastCheck = Date()
            return true
        }
        if due { FilesDomain.changed() }
    }

    // MARK: download

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest,
                       completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        let ours = isOurs
        let task = Task {
            do {
                guard ours else { throw NSFileProviderError(.notAuthenticated) }
                try await Account.ready()
                let item = try await Remote.item(itemIdentifier)
                guard let id = itemIdentifier.nodeId, !item.node.isDir else { throw NSFileProviderError(.noSuchItem) }
                let dest = try temporaryFile()
                try await API.shared.download(id, to: dest)
                progress.completedUnitCount = 1
                completionHandler(dest, item, nil)
            } catch {
                completionHandler(nil, nil, providerError(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    // MARK: local changes → server

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        if itemTemplate.itemIdentifier == .rootContainer { // the system re-imports the root after (re)adding the domain
            return run({ completionHandler($0, [], false, $1) }) { try await Remote.item(.rootContainer) }
        }
        let name = itemTemplate.filename
        let type = itemTemplate.contentType ?? .data
        if isIgnored(name) || type.conforms(to: .symbolicLink) {
            completionHandler(nil, [], false, NSFileProviderError(.excludedFromSync))
            return Progress()
        }
        // A folder the server won't take anything into (read-only share, "Shared with you"): the new item stays on this
        // iPhone, marked as not synced. A permission error instead would be retried for ever and pause the location.
        let done: (Item?, Error?) -> Void = { item, error in
            if let e = error as? CocoaError, e.code == .fileWriteNoPermission {
                completionHandler(nil, [], false, NSFileProviderError(.excludedFromSync))
            } else {
                completionHandler(item, [], false, error)
            }
        }
        return run(done) {
            guard itemTemplate.parentItemIdentifier != .shared, let parentId = itemTemplate.parentItemIdentifier.nodeId else {
                throw CocoaError(.fileWriteNoPermission)
            }
            let siblings = try await API.shared.node(parentId).children ?? []
            let existing = siblings.first { $0.name == name }
            if type.conforms(to: .folder) {
                // Same-named folder on the server: use it, the local contents are added to it.
                if let existing, existing.isDir { return try await Remote.item(NSFileProviderItemIdentifier(node: existing.id)) }
                let folder = try await API.shared.mkdir(parentId, name)
                let item = try await Remote.item(NSFileProviderItemIdentifier(node: folder.id))
                // The system knows this folder is empty and won't list it; track it so server changes inside reach it.
                Index.shared.record(item.itemIdentifier.rawValue, etag: item.node.etag ?? "", children: [:])
                return item
            }
            var empty: URL?
            defer { if let empty { try? FileManager.default.removeItem(at: empty) } }
            let file: URL
            if let url { file = url } else { empty = try self.emptyFile(); file = empty! }
            var target = name
            if let existing {
                // After a re-import the file may be ours already (same content); anything else must not overwrite
                // the server copy.
                if options.contains(.mayAlreadyExist), !existing.isDir, existing.bytes == fileSize(file),
                   let theirs = existing.sha256, theirs == (try? sha256(of: file)) {
                    return try await Remote.item(NSFileProviderItemIdentifier(node: existing.id))
                }
                target = conflictName(name)
            }
            // keepBoth: a file created elsewhere under this name since the listing above is not replaced either.
            guard let id = try await API.shared.upload(parentId, name: target, file: file, keepBoth: true, progress: { _, _ in }) else {
                // Arrived, but the answer naming it was lost: find it by name.
                let now = try await API.shared.node(parentId).children ?? []
                guard let node = now.first(where: { $0.name == target }) else { throw NSFileProviderError(.serverUnreachable) }
                return try await Remote.item(NSFileProviderItemIdentifier(node: node.id))
            }
            return try await Remote.item(NSFileProviderItemIdentifier(node: id))
        }
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                    contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        // `fetch`: the local contents are not what the server has (conflict, or a read-only file edited here): iOS
        // downloads the server's version again.
        run({ (r: (item: NSFileProviderItem, fetch: Bool)?, error) in completionHandler(r?.item, [], r?.fetch ?? false, error) }) { [self] in
            try await modify(item, version: version, changedFields: changedFields, contents: newContents)
        }
    }

    private func modify(_ item: NSFileProviderItem, version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                        contents newContents: URL?) async throws -> (item: NSFileProviderItem, fetch: Bool) {
        guard let id = item.itemIdentifier.nodeId, item.itemIdentifier != .rootContainer, item.itemIdentifier != .shared else {
            throw CocoaError(.fileWriteNoPermission)
        }
        // Contents first: our own rename below gives the file a new etag.
        if changedFields.contains(.contents), let newContents {
            let current = try await API.shared.node(id).node
            guard let parentId = current.parentId else { throw CocoaError(.fileWriteNoPermission) }
            if !Item.sameContent(version, as: current) {
                // The contents changed on the server since this iPhone last had them (a rename or move there is not
                // a change): the edit is kept as a conflicted copy next to it, and the server's version replaces the
                // local one.
                _ = try await API.shared.upload(parentId, name: conflictName(item.filename), file: newContents, keepBoth: true,
                                                progress: { _, _ in })
                return (try await Remote.item(item.itemIdentifier), true)
            }
            do {
                _ = try await API.shared.upload(parentId, name: current.name, file: newContents, progress: { _, _ in })
            } catch let e as APIError where e.status == 403 {
                // Read-only share: iOS sees every file as writable (see Item.capabilities). Put the server's version
                // back instead of failing for ever (which would pause the whole location).
                filesLog.notice("Edit of read-only \(id) not saved: restoring the server's version")
                return (try await Remote.item(item.itemIdentifier), true)
            }
        }
        var patch: [String: Any?] = [:]
        if changedFields.contains(.filename) { patch["name"] = item.filename }
        if changedFields.contains(.parentItemIdentifier) {
            guard item.parentItemIdentifier != .shared, let parentId = item.parentItemIdentifier.nodeId else {
                throw CocoaError(.fileWriteNoPermission)
            }
            patch["parentId"] = parentId
        }
        if !patch.isEmpty { try await API.shared.sendJSON("PATCH", "/api/nodes/\(id)", patch) }
        // Dates, tags and other local metadata stay on the iPhone.
        return (try await Remote.item(item.itemIdentifier), false)
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        run({ _, error in completionHandler(error) }) {
            guard let id = identifier.nodeId, identifier != .rootContainer, identifier != .shared else {
                throw CocoaError(.fileWriteNoPermission)
            }
            do {
                // A folder delete that isn't recursive must not take along what the server has in it and this iPhone
                // never saw (the File Provider contract); the system then asks again with .recursive if meant.
                if !options.contains(.recursive), let l = try? await API.shared.node(id), l.node.isDir, !(l.children ?? []).isEmpty {
                    throw NSFileProviderError(.directoryNotEmpty)
                }
                try await API.shared.delete(id)
            } catch let e as APIError where e.status == 404 {
                // already gone
            }
        }
    }

    // MARK: thumbnails (pictures and PDFs, from servers that make them; other files keep their icon)

    func fetchThumbnails(for itemIdentifiers: [NSFileProviderItemIdentifier], requestedSize size: CGSize,
                         perThumbnailCompletionHandler: @escaping (NSFileProviderItemIdentifier, Data?, Error?) -> Void,
                         completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: Int64(itemIdentifiers.count))
        let ours = isOurs
        let task = Task {
            do {
                guard ours else { throw NSFileProviderError(.notAuthenticated) }
                try await Account.ready()
            } catch {
                completionHandler(providerError(error))
                return
            }
            for id in itemIdentifiers {
                if Task.isCancelled { break }
                var data: Data?
                if let nodeId = id.nodeId, id != .rootContainer {
                    data = await thumbnail(nodeId, pixels: max(size.width, size.height))
                }
                perThumbnailCompletionHandler(id, data, nil)
                progress.completedUnitCount += 1
            }
            completionHandler(Task.isCancelled ? CocoaError(.userCancelled) : nil)
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /// The server's small WebP (pictures and PDFs, server 1.19+). Otherwise, like the app's grid: a picture up to
    /// 20 MB is downloaded to a file and scaled down from there (ImageIO reads only what it needs).
    private func thumbnail(_ id: Int64, pixels: CGFloat) async -> Data? {
        guard let node = try? await API.shared.node(id).node, !node.isDir, node.bytes > 0 else { return nil }
        let mime = node.mime ?? ""
        guard mime.hasPrefix("image/") || mime == "application/pdf" else { return nil } // the rest keeps its icon
        let v = (node.etag ?? "").addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        if let data = try? await API.shared.send("GET", "/api/nodes/\(id)/thumb?v=\(v)") { return data }
        guard mime.hasPrefix("image/"), node.bytes <= 20_000_000, let file = try? temporaryFile() else { return nil }
        defer { try? FileManager.default.removeItem(at: file) }
        guard (try? await API.shared.download(id, to: file)) != nil,
              let src = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: max(pixels, 256)]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    // MARK: helpers

    /// Runs `work` with the account loaded and reports its result (or File Provider error) to `done`.
    private func run<T>(_ done: @escaping (T?, Error?) -> Void, _ work: @escaping () async throws -> T) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        let ours = isOurs
        let task = Task {
            do {
                guard ours else { throw NSFileProviderError(.notAuthenticated) }
                try await Account.ready()
                let value = try await work()
                progress.completedUnitCount = 1
                done(value, nil)
            } catch {
                done(nil, providerError(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    /// Downloads go to a file the system then moves into place.
    private func temporaryFile() throws -> URL {
        let dir = try NSFileProviderManager(for: FilesDomain.domain)?.temporaryDirectoryURL() ?? FileManager.default.temporaryDirectory
        return dir.appendingPathComponent(UUID().uuidString)
    }

    private func emptyFile() throws -> URL {
        let url = try temporaryFile()
        FileManager.default.createFile(atPath: url.path, contents: Data())
        return url
    }
}

/// SHA-256 of a file, read in 1 MiB pieces (the server's `sha256` format: lowercase hex).
private func sha256(of url: URL) throws -> String {
    let fh = try FileHandle(forReadingFrom: url)
    defer { try? fh.close() }
    var hash = SHA256()
    while let piece = try autoreleasepool(invoking: { try fh.read(upToCount: 1 << 20) }), !piece.isEmpty { hash.update(data: piece) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

private func fileSize(_ url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? -1
}

/// System and editor files that stay on the device (same list as the desktop app's sync.ts).
func isIgnored(_ name: String) -> Bool {
    name.range(of: #"^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini|\.directory|Icon\r|~\$.*|\.~lock\..*#|.*\.swp|\.cloudy-tmp-.*)$"#,
               options: [.regularExpression, .caseInsensitive]) != nil
}

/// "report (conflicted copy 2026-10-27 153000).pdf", like the desktop app.
func conflictName(_ name: String) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HHmmss"
    let ext = (name as NSString).pathExtension
    let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
    return "\(stem) (conflicted copy \(f.string(from: Date())))" + (ext.isEmpty ? "" : ".\(ext)")
}
