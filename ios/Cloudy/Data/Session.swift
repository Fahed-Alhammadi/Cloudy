import Foundation
import Observation
import UIKit

/// Server address and signed-in user (UserDefaults); the device token lives in the Keychain.
@Observable
final class Session {
    static let shared = Session()

    private(set) var server: String
    private(set) var user: User?
    var isLoggedIn: Bool { user != nil && !waitingForKeychain && API.shared.token != nil }
    /// The Keychain couldn't be read (this iPhone hasn't been unlocked since it started): the account is neither
    /// signed in nor signed out until it can be. Nothing is removed meanwhile, and no request goes out without the
    /// token (a 401 would sign the account out).
    private(set) var waitingForKeychain = false

    private let defaults = UserDefaults.standard
    /// Shared with the share extension (App Group): where the server is; the device token is in the shared Keychain.
    static let sharedDefaults = UserDefaults(suiteName: appGroup) ?? .standard

    private init() {
        // The server address moved to the App Group so that "Share to Cloudy" can reach the server too.
        if Session.sharedDefaults.string(forKey: "server") == nil, let old = defaults.string(forKey: "server") {
            Session.sharedDefaults.set(old, forKey: "server")
        }
        server = ""
        loadAccount()
        #if DEBUG
        // Simulator testing/screenshots: `SIMCTL_CHILD_CLOUDY_SERVER=… SIMCTL_CHILD_CLOUDY_TOKEN=… xcrun simctl launch …`
        let env = ProcessInfo.processInfo.environment
        if let s = env["CLOUDY_SERVER"], let t = env["CLOUDY_TOKEN"] {
            // Stored like a real sign-in, so the Files extension (which reads them) can be tested too.
            Session.sharedDefaults.set(s, forKey: "server")
            Keychain.set("token", t)
            server = s
            API.shared.server = s
            API.shared.token = t
            user = User(id: "")
            waitingForKeychain = false
            Task { await refresh() }
        }
        #endif
        API.shared.onUnauthorized = { [weak self] in self?.signOut(revoke: false) }
        // The moment the Keychain becomes readable after a launch before the first unlock.
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.retryKeychain() }
    }

    /// Reads the server address, the user and the device token. Only "there is no token" means signed out; a
    /// Keychain that can't be read leaves the question open until `retryKeychain()` gets through. The settings are
    /// read again with it: before the first unlock they can't be read either.
    private func loadAccount() {
        server = Session.sharedDefaults.string(forKey: "server") ?? ""
        API.shared.server = server
        let stored = defaults.data(forKey: "user").flatMap { try? JSONDecoder().decode(User.self, from: $0) }
        switch Keychain.read("token") {
        case .value(let token):
            API.shared.token = token
            if let stored {
                user = stored
                waitingForKeychain = false
            } else if server.isEmpty {
                // A token but no settings: they could not be read either (before the first unlock). Signed out has
                // no token, so this is not it; ask again in a moment.
                waitingForKeychain = true
            } else {
                // The saved profile is missing but the sign-in is there: go on with it and fetch the profile.
                user = User(id: "")
                waitingForKeychain = false
                Task { await refresh() }
            }
        case .missing:
            API.shared.token = nil
            user = nil
            waitingForKeychain = false
        case .unavailable:
            API.shared.token = nil
            user = stored
            waitingForKeychain = true
        }
    }

    /// Reads the token again after a failed read (when protected data becomes available, and while the app is open).
    func retryKeychain() {
        if waitingForKeychain { loadAccount() }
    }

    var rootId: Int64 { user?.rootId ?? 0 }

    func signIn(server: String, token: String, user: User) {
        waitingForKeychain = false
        self.server = server
        Session.sharedDefaults.set(server, forKey: "server")
        Keychain.set("token", token)
        API.shared.server = server
        API.shared.token = token
        update(user)
    }

    func update(_ user: User) {
        defaults.set(try? JSONEncoder().encode(user), forKey: "user")
        // The Files extension maps the root folder to the location itself.
        if let root = user.rootId { Session.sharedDefaults.set(root, forKey: "rootId") }
        self.user = user
    }

    func refresh() async {
        if let me = try? await API.shared.me() { await MainActor.run { update(me) } }
    }

    /// `revoke`: also invalidate the token on the server (not when the server already rejected it).
    func signOut(revoke: Bool = true) {
        guard user != nil || waitingForKeychain else { return }
        // The revoke request gets the token explicitly: `API.shared.token` is cleared below, before the task runs
        // (it used to go out without one, so the server kept the device signed in). The Keychain entry goes now, so a
        // quick sign-in again can't have its new token deleted by this task.
        if revoke, let token = API.shared.token { Task { await API.shared.logout(token: token) } }
        Keychain.delete("token")
        API.shared.token = nil
        waitingForKeychain = false
        // "Share to Cloudy" remembers a folder of this account; it means nothing to the next one.
        Session.sharedDefaults.removeObject(forKey: "shareFolderId")
        Session.sharedDefaults.removeObject(forKey: "shareFolderName")
        Session.sharedDefaults.removeObject(forKey: "rootId")
        defaults.removeObject(forKey: "user")
        user = nil
        FileCache.clear()
        Task { await Thumbnails.shared.clear() }
        Task { await Avatars.shared.clear() }
    }
}
