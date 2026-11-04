import Foundation
import Observation

/// Server address and signed-in user (UserDefaults); the device token lives in the Keychain.
@Observable
final class Session {
    static let shared = Session()

    private(set) var server: String
    private(set) var user: User?
    var isLoggedIn: Bool { user != nil && API.shared.token != nil }

    private let defaults = UserDefaults.standard
    /// Shared with the share extension (App Group): where the server is; the device token is in the shared Keychain.
    static let sharedDefaults = UserDefaults(suiteName: appGroup) ?? .standard

    private init() {
        // The server address moved to the App Group so that "Share to Cloudy" can reach the server too.
        if Session.sharedDefaults.string(forKey: "server") == nil, let old = defaults.string(forKey: "server") {
            Session.sharedDefaults.set(old, forKey: "server")
        }
        server = Session.sharedDefaults.string(forKey: "server") ?? ""
        user = defaults.data(forKey: "user").flatMap { try? JSONDecoder().decode(User.self, from: $0) }
        API.shared.server = server
        API.shared.token = Keychain.get("token")
        #if DEBUG
        // Simulator testing/screenshots: `SIMCTL_CHILD_CLOUDY_SERVER=… SIMCTL_CHILD_CLOUDY_TOKEN=… xcrun simctl launch …`
        let env = ProcessInfo.processInfo.environment
        if let s = env["CLOUDY_SERVER"], let t = env["CLOUDY_TOKEN"] {
            server = s
            API.shared.server = s
            API.shared.token = t
            user = User(id: "")
            Task { await refresh() }
        }
        #endif
        if API.shared.token == nil { user = nil }
        API.shared.onUnauthorized = { [weak self] in self?.signOut(revoke: false) }
    }

    var rootId: Int64 { user?.rootId ?? 0 }

    func signIn(server: String, token: String, user: User) {
        self.server = server
        Session.sharedDefaults.set(server, forKey: "server")
        Keychain.set("token", token)
        API.shared.server = server
        API.shared.token = token
        update(user)
    }

    func update(_ user: User) {
        defaults.set(try? JSONEncoder().encode(user), forKey: "user")
        self.user = user
    }

    func refresh() async {
        if let me = try? await API.shared.me() { await MainActor.run { update(me) } }
    }

    /// `revoke`: also invalidate the token on the server (not when the server already rejected it).
    func signOut(revoke: Bool = true) {
        guard user != nil else { return }
        // The revoke request gets the token explicitly: `API.shared.token` is cleared below, before the task runs
        // (it used to go out without one, so the server kept the device signed in). The Keychain entry goes now, so a
        // quick sign-in again can't have its new token deleted by this task.
        if revoke, let token = API.shared.token { Task { await API.shared.logout(token: token) } }
        Keychain.delete("token")
        API.shared.token = nil
        // "Share to Cloudy" remembers a folder of this account; it means nothing to the next one.
        Session.sharedDefaults.removeObject(forKey: "shareFolderId")
        Session.sharedDefaults.removeObject(forKey: "shareFolderName")
        defaults.removeObject(forKey: "user")
        user = nil
        FileCache.clear()
        Task { await Thumbnails.shared.clear() }
    }
}
