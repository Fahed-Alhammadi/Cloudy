import Foundation
import Network
import dnssd

/// Triggers iOS's "Local Network" permission dialog before the first sign-in, so a request to a server on the
/// home/office network (http://192.168.…) doesn't fail while the dialog is still open.
///
/// iOS has no API to ask for this permission directly: advertising and browsing a Bonjour service does it.
/// Browsing a type listed under `NSBonjourServices` (Info.plist) fails with `PolicyDenied` when the user declines;
/// our own advertisement is only registered once they allow. Nothing is sent to anyone.
enum LocalNetwork {
    private static let serviceType = "_cloudy._tcp"

    /// Shows the dialog if it hasn't been answered yet. Returns true = allowed, false = denied, nil = no answer in time
    /// (the simulator and devices without a network never answer; the app works normally without it).
    static func request(timeout: TimeInterval = 60) async -> Bool? {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool?, Never>) in
            let params = NWParameters.tcp
            params.includePeerToPeer = true
            let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: params)
            let listener = try? NWListener(using: params)
            listener?.service = NWListener.Service(type: serviceType)
            let once = Once()
            @Sendable func finish(_ result: Bool?) {
                guard once.first() else { return }
                browser.cancel()
                listener?.cancel()
                cont.resume(returning: result)
            }
            browser.stateUpdateHandler = { state in
                if case .waiting(let error) = state, case .dns(let code) = error,
                   code == DNSServiceErrorType(kDNSServiceErr_PolicyDenied) { finish(false) }
                if case .failed = state { finish(nil) }
            }
            listener?.serviceRegistrationUpdateHandler = { change in
                if case .add = change { finish(true) }
            }
            listener?.newConnectionHandler = { $0.cancel() }
            listener?.stateUpdateHandler = { state in if case .failed = state { finish(nil) } }
            browser.start(queue: .main)
            listener?.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }

    /// Whether `host` is on a local network (private IP ranges, `.local` names, localhost): only then does iOS need
    /// the local network permission and allow plain http://.
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".local") || h == "::1" { return true }
        let parts = h.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return h.hasPrefix("fe80:") || h.hasPrefix("fd") || h.hasPrefix("fc") }
        return parts[0] == 10 || parts[0] == 127 || (parts[0] == 192 && parts[1] == 168)
            || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 169 && parts[1] == 254)
    }
}

/// `first()` is true exactly once, from any thread.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
