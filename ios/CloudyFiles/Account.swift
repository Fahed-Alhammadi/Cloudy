import FileProvider
import Foundation

/// The app's signed-in account as the extension sees it: server address and the user's root folder id in the App
/// Group defaults, the device token in the shared Keychain (written by `Session`; nothing is stored twice). Read on
/// every request, never cached: the extension process can outlive a sign-out and serve the next account.
enum Account {
    private static let defaults = UserDefaults(suiteName: appGroup) ?? .standard
    private static let lock = NSLock()
    /// Root learned from `/api/me` for a server+token whose root the app hasn't stored yet (signed in before 1.20).
    nonisolated(unsafe) private static var learned: (key: String, root: Int64)?

    static var rootId: Int64 {
        if let v = defaults.object(forKey: "rootId") as? NSNumber, v.int64Value > 0 { return v.int64Value }
        let key = API.shared.server + "|" + (API.shared.token ?? "")
        return lock.withLock { learned?.key == key ? learned!.root : 0 }
    }

    /// Points `API.shared` at the account and makes sure the index belongs to it; throws `.notAuthenticated` when
    /// the app is signed out.
    static func ready() async throws {
        let server = defaults.string(forKey: "server") ?? ""
        let token: String
        // The Keychain first: only "there is no token" means signed out.
        switch Keychain.read("token") {
        case .value(let t): token = t
        case .missing: throw NSFileProviderError(.notAuthenticated)
        // The Keychain can't be read yet (iOS started the extension before the iPhone's first unlock): that is not
        // "signed out", which would show "Authentication Required". The system tries again by itself after this.
        case .unavailable: throw NSFileProviderError(.serverUnreachable)
        }
        // A token without a server address: the settings can't be read yet either. Try again later, like above.
        guard !server.isEmpty else { throw NSFileProviderError(.serverUnreachable) }
        if API.shared.server != server { API.shared.server = server }
        if API.shared.token != token { API.shared.token = token }
        if rootId == 0 {
            let me = try await API.shared.me()
            guard let root = me.rootId else { throw NSFileProviderError(.notAuthenticated) }
            lock.withLock { learned = (server + "|" + token, root) }
        }
        // Another account (or server) than the one the index was built for: start over. The new session also
        // expires the system's sync anchors, so nothing of the previous account is reported as this one's.
        Index.shared.use(account: "\(server)|\(rootId)")
    }
}
