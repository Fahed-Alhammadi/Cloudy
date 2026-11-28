import FileProvider
import UniformTypeIdentifiers

extension NSFileProviderItemIdentifier {
    /// Virtual folder at the root listing the files others shared with this user.
    static let shared = NSFileProviderItemIdentifier("shared")

    init(node id: Int64) { self = id == Account.rootId ? .rootContainer : NSFileProviderItemIdentifier(String(id)) }

    /// Server node id; nil for the virtual "Shared with you" folder (and the working set / trash).
    var nodeId: Int64? { self == .rootContainer ? Account.rootId : Int64(rawValue) }
}

/// A Cloudy node as the Files app sees it. Versions: a file's content version is the hash of its contents (its etag
/// when the server hasn't sent one), its metadata version follows the etag; a folder's etag changes with every edit
/// below it, so folders only carry name + parent.
final class Item: NSObject, NSFileProviderItem {
    let node: FileNode
    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let canEdit: Bool

    init(_ node: FileNode, parent: NSFileProviderItemIdentifier, canEdit: Bool) {
        self.node = node
        itemIdentifier = NSFileProviderItemIdentifier(node: node.id)
        parentItemIdentifier = itemIdentifier == .rootContainer ? .rootContainer : parent
        self.canEdit = canEdit
    }

    private init(virtual id: NSFileProviderItemIdentifier, name: String) {
        node = FileNode(id: -1, name: name, isDir: true)
        itemIdentifier = id
        parentItemIdentifier = .rootContainer
        canEdit = false
    }

    static var sharedFolder: Item { Item(virtual: .shared, name: String(localized: "Shared with you")) }

    /// Where a node sits: share roots under "Shared with you", everything else under its server parent.
    static func parent(of node: FileNode) -> NSFileProviderItemIdentifier {
        let id = NSFileProviderItemIdentifier(node: node.id).rawValue
        if Index.shared.folder(NSFileProviderItemIdentifier.shared.rawValue)?.children[id] != nil { return .shared }
        guard let p = node.parentId else { return .rootContainer }
        return NSFileProviderItemIdentifier(node: p)
    }

    var filename: String { itemIdentifier == .rootContainer || node.name.isEmpty ? "Cloudy" : node.name }
    var contentType: UTType { node.isDir ? .folder : UTType(filenameExtension: node.ext) ?? .data }
    var documentSize: NSNumber? { node.isDir ? nil : NSNumber(value: node.bytes) }
    // The system can't create an item dated 1970 (the virtual "Shared with you" folder has no date): a fixed one.
    var contentModificationDate: Date? { node.modified ?? Item.noDate }
    var creationDate: Date? { node.modified ?? Item.noDate }
    private static let noDate = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01

    var capabilities: NSFileProviderItemCapabilities {
        // Always writable as far as iOS knows: it can't create read-only (locked) items on disk — create-item fails
        // with "cannotSetMetadata", the item never shows and the location reports "Syncing Paused" (seen for read-only
        // shares and the virtual "Shared with you" folder). The server still decides: saving to a read-only share
        // fails with "no permission".
        var c: NSFileProviderItemCapabilities = [.allowsReading, .allowsContentEnumerating, .allowsWriting]
        if node.isDir { c.insert(.allowsAddingSubItems) }
        // Rename, move and delete only where the server allows them; share roots and the root itself stay put.
        if canEdit && itemIdentifier != .rootContainer && parentItemIdentifier != .shared && itemIdentifier != .shared {
            c.formUnion([.allowsRenaming, .allowsReparenting, .allowsDeleting])
        }
        return c
    }

    /// The contents' SHA-256 when the server sends it. The etag alone was used before, but the server gives a file a
    /// new etag when it is only renamed or moved: an edit made here before the next change walk then looked like a
    /// change on both sides and was uploaded as a "conflicted copy".
    private var contentVersion: String { node.isDir ? "dir" : node.sha256 ?? node.etag ?? "" }
    private var metadataVersion: String {
        "\(node.name)|\(parentItemIdentifier.rawValue)|\(canEdit)|\(node.isDir ? "dir" : node.etag ?? "")"
    }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data(contentVersion.utf8), metadataVersion: Data(metadataVersion.utf8))
    }

    /// Changes whenever the system needs to hear about this item again (stored in `Index`).
    var versionKey: String { metadataVersion }

    /// Whether `base` (the content version an edit on this iPhone started from) is what the server still has.
    /// The etag is accepted too: items listed before content hashes were used, or before the server had computed
    /// the hash, carry it as their content version.
    static func sameContent(_ base: NSFileProviderItemVersion, as node: FileNode) -> Bool {
        let v = String(decoding: base.contentVersion, as: UTF8.self)
        return !v.isEmpty && (v == node.sha256 || v == node.etag)
    }
}
