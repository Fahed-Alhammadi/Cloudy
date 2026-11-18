import Foundation

/// What the extension last reported to the system, per folder the Files app has listed: the folder's etag and a
/// version key per child. Change enumeration walks down from the root and re-reads only listed folders whose etag
/// moved (etags change all the way up the tree on every edit), like the desktop app's folder-etag listing cache.
/// Kept as JSON in the App Group container (`FilesDomain.stateDir`); the app deletes it when it removes the domain,
/// and it belongs to one account (`use(account:)`).
final class Index: @unchecked Sendable {
    struct Folder: Codable {
        var etag: String
        /// child item identifier → version key (`Item.versionKey`)
        var children: [String: String]
    }

    private struct State: Codable {
        var session = UUID().uuidString
        var counter = 0
        var folders: [String: Folder] = [:]
        /// "server|rootId" this state belongs to (`Account.ready`).
        var account: String?
    }

    static let shared = Index()
    private static var file: URL { FilesDomain.stateDir.appendingPathComponent("index.json") }

    private let lock = NSLock()
    private var state: State

    private init() {
        state = (try? Data(contentsOf: Index.file)).flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
    }

    func folder(_ id: String) -> Folder? { lock.withLock { state.folders[id] } }

    var account: String? { lock.withLock { state.account } }

    /// Makes the index belong to `account`; another account's state is dropped (with a new session, which expires
    /// the system's anchors).
    func use(account: String) {
        lock.withLock {
            guard state.account != account else { return }
            if state.account != nil || !state.folders.isEmpty { state = State() }
            state.account = account
            save()
        }
    }

    /// Remembers a folder as just listed for the Files app.
    func record(_ id: String, etag: String, children: [String: String]) {
        lock.withLock {
            state.folders[id] = Folder(etag: etag, children: children)
            save()
        }
    }

    /// Applies a finished change walk in one go (a walk that fails part-way changes nothing, so the next one finds
    /// the same differences again): new folder states, then folders that no longer exist (and everything known below
    /// them). Ignored when the account changed meanwhile.
    func commit(_ folders: [String: Folder], forget gone: Set<String>, account: String?) {
        lock.withLock {
            guard state.account == account else { return }
            for (id, f) in folders { state.folders[id] = f }
            var queue = Array(gone)
            while let id = queue.popLast() {
                if let f = state.folders.removeValue(forKey: id) { queue.append(contentsOf: f.children.keys) }
            }
            save()
        }
    }

    /// Anchor = session + counter. A different session (index lost, reset or another account) means it expired.
    var anchor: Data { lock.withLock { Data("\(state.session):\(state.counter)".utf8) } }

    func isCurrent(_ anchor: Data) -> Bool {
        let s = String(decoding: anchor, as: UTF8.self)
        return lock.withLock { s.hasPrefix(state.session + ":") }
    }

    func bump() -> Data {
        lock.withLock {
            state.counter += 1
            save()
            return Data("\(state.session):\(state.counter)".utf8)
        }
    }

    private func save() {
        try? FileManager.default.createDirectory(at: FilesDomain.stateDir, withIntermediateDirectories: true)
        try? JSONEncoder().encode(state).write(to: Index.file, options: .atomic)
    }
}
