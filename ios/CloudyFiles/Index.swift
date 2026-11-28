import Foundation

/// What the extension last reported to the system, per folder the Files app has listed: the folder's etag and a
/// version key per child. Change enumeration walks down from the root and re-reads only listed folders whose etag
/// moved (etags change all the way up the tree on every edit), like the desktop app's folder-etag listing cache.
/// Kept as JSON in the App Group container (`FilesDomain.stateDir`); the app deletes it when it removes the domain,
/// and it belongs to one account (`use(account:)`).
///
/// The memory copy is what the extension works with; the file only matters to the next extension process. The whole
/// file used to be rewritten, inside the lock, on every listing, every change walk and every anchor (twice per live
/// event). Now: a listing is on disk before the system is told about the folder (a folder missing from the file would
/// never be checked for changes again), written outside the lock and shared by listings that finish together; change
/// walks and anchors are written within a second (losing one only makes the next walk report the same changes again).
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
    /// `state` has changes the file doesn't.
    private var dirty = false
    /// A delayed write is on its way.
    private var writeScheduled = false
    /// All writes happen here, one after another, so an older state can't land on top of a newer one.
    private let io = DispatchQueue(label: "io.cloudy.app.files.index", qos: .utility)

    private init() {
        state = (try? Data(contentsOf: Index.file)).flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
    }

    func folder(_ id: String) -> Folder? { lock.withLock { state.folders[id] } }

    var account: String? { lock.withLock { state.account } }

    /// Makes the index belong to `account`; another account's state is dropped (with a new session, which expires
    /// the system's anchors).
    func use(account: String) {
        let changed = lock.withLock { () -> Bool in
            guard state.account != account else { return false }
            if state.account != nil || !state.folders.isEmpty { state = State() }
            state.account = account
            dirty = true
            return true
        }
        if changed { flush() }
    }

    /// Remembers a folder as just listed for the Files app.
    func record(_ id: String, etag: String, children: [String: String]) {
        lock.withLock {
            state.folders[id] = Folder(etag: etag, children: children)
            dirty = true
        }
        flush()
    }

    /// Applies a finished change walk in one go (a walk that fails part-way changes nothing, so the next one finds
    /// the same differences again): new folder states, then folders that no longer exist (and everything known below
    /// them). Ignored when the account changed meanwhile.
    func commit(_ folders: [String: Folder], forget gone: Set<String>, account: String?) {
        lock.withLock {
            guard state.account == account else { return }
            if folders.isEmpty && gone.isEmpty { return } // nothing changed: nothing to write
            for (id, f) in folders { state.folders[id] = f }
            var queue = Array(gone)
            while let id = queue.popLast() {
                if let f = state.folders.removeValue(forKey: id) { queue.append(contentsOf: f.children.keys) }
            }
            saveSoon()
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
            saveSoon()
            return Data("\(state.session):\(state.counter)".utf8)
        }
    }

    /// Writes the state now if the file is behind, and returns when it is on disk.
    func flush() {
        io.sync { write() }
    }

    /// Call with the lock held: one write, a second from now, for everything that changes until then.
    private func saveSoon() {
        dirty = true
        guard !writeScheduled else { return }
        writeScheduled = true
        io.asyncAfter(deadline: .now() + 1) { [self] in
            lock.withLock { writeScheduled = false }
            write()
        }
    }

    /// On `io` only. The state is copied inside the lock and encoded and written outside it.
    private func write() {
        let snapshot: State? = lock.withLock {
            guard dirty else { return nil }
            dirty = false
            return state
        }
        guard let snapshot else { return }
        try? FileManager.default.createDirectory(at: FilesDomain.stateDir, withIntermediateDirectories: true)
        do {
            try JSONEncoder().encode(snapshot).write(to: Index.file, options: .atomic)
        } catch {
            lock.withLock { dirty = true } // the next write tries again
            filesLog.error("Index not saved: \(error, privacy: .public)")
        }
    }
}
