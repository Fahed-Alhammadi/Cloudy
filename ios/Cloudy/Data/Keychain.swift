import Foundation
import Security

/// App Group shared by the app and its extensions (settings such as the server address and the app lock).
let appGroup = "group.io.cloudy.app"

/// Minimal generic-password Keychain wrapper (this device only, readable after first unlock).
/// The item lives in the keychain access group both targets list first (`io.cloudy.app`), so the share
/// extension can use the device token without storing it a second time.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.cloudy.app", kSecAttrAccount as String: key]
    }

    /// What a read found. `unavailable` is neither a token nor "signed out": the Keychain could not be read right
    /// now (this iPhone hasn't been unlocked since it started, or the system refused for another reason).
    enum Read: Equatable {
        case value(String)
        case missing
        case unavailable
    }

    /// Every failed read used to count as "no token": a launch before the first unlock looked like a sign-out, and
    /// the app then removed the Files location and its downloaded copies although the token was fine.
    static func read(_ key: String) -> Read {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        switch SecItemCopyMatching(q as CFDictionary, &out) {
        case errSecSuccess:
            guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return .missing }
            return .value(s)
        case errSecItemNotFound: return .missing
        default: return .unavailable
        }
    }

    static func set(_ key: String, _ value: String) {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}
