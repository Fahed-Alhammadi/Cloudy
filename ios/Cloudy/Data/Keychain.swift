import Foundation
import Security

/// App Group shared by the app and its share extension (settings such as the server address).
let appGroup = "group.io.cloudy.app"

/// Minimal generic-password Keychain wrapper (this device only, readable after first unlock).
/// The item lives in the keychain access group both targets list first (`io.cloudy.app`), so the share
/// extension can use the device token without storing it a second time.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.cloudy.app", kSecAttrAccount as String: key]
    }

    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
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
