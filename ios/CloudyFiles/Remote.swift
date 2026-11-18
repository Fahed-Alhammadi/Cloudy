import FileProvider
import Foundation

/// Reads the server for the extension: folder listings, single items and the change walk.
enum Remote {
    static func item(_ id: NSFileProviderItemIdentifier) async throws -> Item {
        if id == .shared { return Item.sharedFolder }
        guard let nodeId = id.nodeId else { throw NSFileProviderError(.noSuchItem) }
        let l = try await API.shared.node(nodeId)
        return Item(l.node, parent: Item.parent(of: l.node), canEdit: l.canEdit)
    }

    /// A folder's etag and children, without touching the index.
    static func fetch(_ container: NSFileProviderItemIdentifier) async throws -> (etag: String, items: [Item]) {
        if container == .shared {
            let nodes = try await API.shared.sharedWithMe()
            let items = nodes.map { Item($0, parent: .shared, canEdit: $0.canEdit ?? false) }
            // No etag for this list: a digest of what it shows (ids, names, contents, permissions).
            let etag = items.map { "\($0.itemIdentifier.rawValue)=\($0.versionKey)=\($0.node.etag ?? "")" }.sorted().joined(separator: ";")
            return (etag, items)
        }
        guard let id = container.nodeId else { throw NSFileProviderError(.noSuchItem) }
        let l = try await API.shared.node(id)
        guard l.node.isDir else { throw NSFileProviderError(.noSuchItem) }
        var items = (l.children ?? []).map { Item($0, parent: container, canEdit: l.canEdit) }
        if container == .rootContainer { items.append(Item.sharedFolder) }
        return (l.node.etag ?? "", items)
    }

    /// Lists a folder for the Files app and remembers what was reported.
    static func list(_ container: NSFileProviderItemIdentifier) async throws -> [Item] {
        let (etag, items) = try await fetch(container)
        Index.shared.record(container.rawValue, etag: etag, children: versions(items))
        return items
    }

    static func versions(_ items: [Item]) -> [String: String] {
        Dictionary(items.map { ($0.itemIdentifier.rawValue, $0.versionKey) }, uniquingKeysWith: { a, _ in a })
    }

    /// Everything that changed since the index was last updated. Only folders the Files app has listed are compared,
    /// and of those only the ones whose etag moved are read again: an unchanged root costs one request. A folder
    /// nobody opened yet is listed when it is opened, so the first pass doesn't crawl the whole account.
    /// The index is only updated when the whole walk succeeded (a failed read part-way must not hide the changes
    /// found so far from the next attempt).
    static func changes() async throws -> (updated: [Item], deleted: [NSFileProviderItemIdentifier]) {
        let account = Index.shared.account
        var staged: [String: Index.Folder] = [:]
        var updated: [String: Item] = [:]
        var deleted = Set<String>()
        var read = 0

        func walk(_ container: NSFileProviderItemIdentifier) async throws {
            let old = Index.shared.folder(container.rawValue)
            read += 1
            let fetched: (etag: String, items: [Item])
            do {
                fetched = try await fetch(container)
            } catch let e as APIError where (e.status == 404 || e.status == 403) && container != .rootContainer && container != .shared {
                // Folder gone (deleted, moved out of reach, share removed): its parent reports the deletion. Never the
                // root or "Shared with you": a 404 there is a wrong account or a misrouted proxy, so the walk fails.
                deleted.insert(container.rawValue)
                return
            }
            if let old, fetched.etag == old.etag { return }
            let now = versions(fetched.items)
            for item in fetched.items {
                let id = item.itemIdentifier.rawValue
                if old?.children[id] != item.versionKey { updated[id] = item }
            }
            if let old { deleted.formUnion(old.children.keys.filter { now[$0] == nil }) }
            staged[container.rawValue] = Index.Folder(etag: fetched.etag, children: now)
            for item in fetched.items where item.node.isDir {
                let id = item.itemIdentifier
                // The listing carries each child folder's etag, so unchanged folders aren't read again.
                if id != .shared, let known = Index.shared.folder(id.rawValue), known.etag != (item.node.etag ?? "") {
                    try await walk(id)
                }
            }
        }

        try await walk(.rootContainer)
        // Shares from others don't touch this user's etags, so "Shared with you" is compared on every pass.
        try await walk(.shared)
        // A node moved between two listed folders shows up as updated in its new place, not deleted.
        deleted.subtract(updated.keys)
        Index.shared.commit(staged, forget: deleted, account: account)
        filesLog.info("Changes: read \(read) folders, \(updated.count) updated, \(deleted.count) deleted")
        return (Array(updated.values), deleted.map { NSFileProviderItemIdentifier($0) })
    }
}

/// Server and network errors as File Provider errors, so the Files app shows the right state.
func providerError(_ error: Error) -> Error {
    if let e = error as? APIError {
        switch e.status {
        case 401: return NSFileProviderError(.notAuthenticated)
        case 404: return NSFileProviderError(.noSuchItem)
        case 403: return CocoaError(.fileWriteNoPermission)
        case 409: return NSFileProviderError(.filenameCollision)
        case 413, 507: return NSFileProviderError(.insufficientQuota)
        default: return NSFileProviderError(.serverUnreachable)
        }
    }
    if error is URLError { return NSFileProviderError(.serverUnreachable) }
    if error is CancellationError { return CocoaError(.userCancelled) }
    return error
}
