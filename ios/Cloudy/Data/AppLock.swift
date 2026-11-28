import Foundation
import LocalAuthentication

/// More → App lock: Face ID, Touch ID or the passcode when coming back to Cloudy, and before "Share to Cloudy" shows
/// folders or uploads. The switch is kept in the App Group, where the share extension can read it: it used to live in
/// the app's own settings, so with the lock on anyone holding the unlocked iPhone could still browse the folders and
/// upload from another app's share sheet.
enum AppLock {
    static let key = "appLock"
    static let defaults = UserDefaults(suiteName: appGroup) ?? .standard

    static var isOn: Bool {
        migrate()
        return defaults.bool(forKey: key)
    }

    /// In the app: people who had the lock on before it moved to the App Group keep it on. (The extension has no
    /// such old value; it sees the lock from the first time the app runs after the update.) Does nothing once the
    /// App Group has the switch.
    static func migrate() {
        let old = UserDefaults.standard
        if defaults !== old, defaults.object(forKey: key) == nil, old.object(forKey: key) != nil {
            defaults.set(old.bool(forKey: key), forKey: key)
        }
    }

    enum Outcome {
        case ok
        /// Cancelled, or Face ID / Touch ID / the passcode didn't match.
        case failed
        /// This iPhone has no passcode: there is nothing to ask for.
        case notSetUp
    }

    /// The system's Face ID / Touch ID / passcode prompt. Call it straight from the user's own action.
    static func authenticate(reason: String) async -> Outcome {
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return .notSetUp }
        return await withCheckedContinuation { cont in
            ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
                cont.resume(returning: ok ? .ok : .failed)
            }
        }
    }

    /// This iPhone has Face ID, but it is switched off for Cloudy in the Settings app (Touch ID has no such switch).
    static var biometryDenied: Bool {
        let ctx = LAContext()
        var error: NSError?
        if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) { return false }
        return ctx.biometryType == .faceID && error?.code == LAError.biometryNotAvailable.rawValue
    }
}
