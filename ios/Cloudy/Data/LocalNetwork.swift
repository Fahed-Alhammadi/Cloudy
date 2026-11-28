import Foundation
import Network
import dnssd

/// Triggers iOS's "Local Network" permission dialog when the user signs in to a server on the home/office network
/// (http://192.168.…), so the sign-in request doesn't fail while the dialog is still open. There is no screen of our
/// own before the dialog (App Review guideline 5.1.1(iv)): it comes straight from the Sign in button.
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
    /// IPv6 is only recognised as a literal address (it contains ":", with or without the URL's brackets): the check
    /// used to be "starts with fc or fd", which made names such as fdrive.example.com local, so signing in to a
    /// server on the internet asked for the Local Network permission and a "Don't Allow" blocked the sign-in.
    static func isLocal(_ host: String) -> Bool {
        var h = host.lowercased()
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        if h == "localhost" || h.hasSuffix(".local") { return true }
        if h.contains(":") {
            if let zone = h.firstIndex(of: "%") { h = String(h[..<zone]) } // fe80::1%en0
            if h == "::1" { return true }
            if h.hasPrefix("::ffff:"), h.contains(".") { return isLocal(String(h.dropFirst(7))) } // IPv4 written as IPv6
            guard let first = h.split(separator: ":", omittingEmptySubsequences: false).first,
                  let group = UInt16(first, radix: 16) else { return false }
            // fc00::/7 = unique local addresses, fe80::/10 = link-local.
            return group & 0xfe00 == 0xfc00 || group & 0xffc0 == 0xfe80
        }
        // Four numbers and nothing else: "10.0.0.1.example.com" is a name on the internet.
        let parts = h.split(separator: ".", omittingEmptySubsequences: false).map { UInt8($0) }
        guard parts.count == 4, let a = parts[0], let b = parts[1], parts[2] != nil, parts[3] != nil else { return false }
        return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && (16...31).contains(b)) || (a == 169 && b == 254)
    }

    /// This iPhone itself: reached without the local network permission.
    static func isLoopback(_ host: String) -> Bool {
        var h = host.lowercased()
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        return h == "localhost" || h == "::1" || (isLocal(h) && h.hasPrefix("127."))
    }
}

/// `first()` is true exactly once, from any thread.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
