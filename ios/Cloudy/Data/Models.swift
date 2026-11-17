import Foundation

// JSON models of the Cloudy API (keep in sync with the server and Android's data/Models.kt).
// Fields the server may leave out are optional; the computed properties give their defaults.

struct User: Codable, Hashable {
    var id: String
    var displayName: String?
    var email: String?
    var isAdmin: Bool?
    var quotaBytes: Int64?
    var used: Int64?
    var rootId: Int64?
    /// Days the server keeps deleted files in the trash.
    var trashDays: Int?
    /// The server makes small previews of pictures and PDFs (`/api/nodes/{id}/thumb`, server 1.19+, `/api/me` only).
    var thumbnails: Bool?
    /// The profile picture's version (`GET /api/users/{id}/avatar?v=<it>`, server 1.20+), nil when there is none.
    var avatar: String?

    var name: String { (displayName ?? "").isEmpty ? id : displayName! }
}

/// A device token (Settings → Devices on the web, More → Devices here).
struct AppPassword: Codable, Identifiable, Hashable {
    var id: Int64
    var name: String
    var createdAt: String?
    var lastUsedAt: String?
    /// The token this phone is signed in with.
    var current: Bool?
}

struct TokenResponse: Codable {
    var token: String
    var user: User
}

struct FileNode: Codable, Identifiable, Hashable {
    var id: Int64
    var name: String
    var isDir: Bool
    var size: Int64?
    var mime: String?
    var etag: String?
    var mtime: String?
    var owner: String?
    var parentId: Int64?
    var favorite: Bool?
    var shared: Bool?
    // Present on "shared with you" and search results.
    var canEdit: Bool?
    var ownerName: String?
    /// The owner's profile picture version ("shared with you", server 1.20+).
    var ownerAvatar: String?
    var shareId: Int64?
    var shareType: String?
    var path: String?

    var bytes: Int64 { size ?? 0 }
    var isFavorite: Bool { favorite ?? false }
    var modified: Date? { parseDate(mtime) }
    var ext: String { (name as NSString).pathExtension.lowercased() }
}

struct Crumb: Codable, Hashable {
    var id: Int64
    var name: String
}

struct NodeListing: Codable {
    var node: FileNode
    var perm: String
    var breadcrumb: [Crumb]
    var children: [FileNode]?

    var canEdit: Bool { perm == "edit" || perm == "owner" }
}

struct TrashItem: Codable, Identifiable, Hashable {
    var id: Int64
    var name: String
    var isDir: Bool
    var size: Int64?
    var mime: String?
    var deletedAt: String?
    var originalPath: String?
}

struct Share: Codable, Identifiable, Hashable {
    var id: Int64
    var nodeId: Int64
    var type: String
    var shareWith: String?
    /// The person's display name and profile picture version (user shares, server 1.20+).
    var shareWithName: String?
    var shareWithAvatar: String?
    var canEdit: Bool?
    var token: String?
    var url: String?
    var hasPassword: Bool?
    var expiresAt: String?
    var node: FileNode?
}

struct UploadSession: Codable {
    var id: String
    var chunkSize: Int
    var received: Int64?
}

/// `GET /api/uploads/{id}`: how much of an unfinished upload the server has.
struct UploadStatus: Codable {
    var received: Int64
    var size: Int64?
}

struct UploadedNode: Codable {
    var id: Int64
    var name: String
}

struct ChunkResult: Codable {
    var received: Int64
    var done: Bool
    var node: UploadedNode?
}

struct Sharees: Codable {
    var users: [Sharee]?
    var groups: [ShareeGroup]?
}

struct Sharee: Codable, Hashable {
    var id: String
    var displayName: String?
    var avatar: String?
}

struct ShareeGroup: Codable, Hashable {
    var id: String
}

/// Live update from `GET /api/events`: folders whose listing changed; `shares` = shared-with-me changed.
struct ChangeEvent: Codable {
    var folders: [Int64]?
    var shares: Bool?
}

// MARK: - Local file names

/// A file name from the server (or another app) as exactly one path component, so it can't point outside the folder
/// it is put in: a malicious server, or anyone in the middle of a local-network http:// connection, could otherwise send
/// "../../Library/Preferences/x.plist". Same rules as the desktop client's `checkName`: `/`, `\`, NUL (and other control
/// characters) become "_", and "", "." and ".." become `fallback`. Long names are cut to the 255-byte file-system limit,
/// keeping the extension.
func safeFileName(_ name: String, fallback: String = "file") -> String {
    var s = String(String.UnicodeScalarView(name.unicodeScalars.map { c in
        c == "/" || c == "\\" || c.value < 0x20 || c.value == 0x7F ? "_" : c
    }))
    if s.isEmpty || s == "." || s == ".." { s = fallback }
    if s.utf8.count > 255 {
        let ext = (s as NSString).pathExtension
        let tail = ext.isEmpty || ext.utf8.count > 16 ? "" : "." + ext
        var base = String(s.dropLast(tail.count))
        while base.utf8.count + tail.utf8.count > 255 { base.removeLast() }
        s = base + tail
    }
    return s
}

/// Ids and etags used in local paths and cache keys: ASCII letters, digits, "_" and "-" only.
func safeToken(_ s: String) -> String {
    String(String.UnicodeScalarView(s.unicodeScalars.filter { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") }))
}

// MARK: - Dates

private let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let isoPlain = ISO8601DateFormatter()

/// Server timestamps: ISO 8601 with or without milliseconds.
func parseDate(_ s: String?) -> Date? {
    guard let s, !s.isEmpty else { return nil }
    return isoFrac.date(from: s) ?? isoPlain.date(from: s)
}
