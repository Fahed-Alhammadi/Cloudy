// Cloudy's Finder Sync extension: badges on the items in the sync folders (green tick = synced, blue arrows = being
// synced or waiting, red ! = not synced). It knows nothing itself: it asks the Cloudy app over a loopback connection.
// The app writes its port and two random values to ~/Library/Application Support/Cloudy/finder.json, the one file
// this sandboxed extension may read. The app's first line must carry one of them (else this is not Cloudy: nothing is
// sent), then this extension sends the other. Protocol: see desktop/src/main/finder.ts. When
// Cloudy is not running there are no badges (no folders are watched).
import Cocoa
import FinderSync

final class FinderSync: FIFinderSync {
    private let queue = DispatchQueue(label: "io.cloudy.desktop.finder")
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private var buffer = Data()
    /** Items Finder asked about (by `key`, as Finder spells them): asked again when the app says they changed. */
    private var known = [String: String]()
    /** Items to ask about with the next message (collected for a moment: Finder asks item by item). */
    private var waiting = Set<String>()
    private var flushPlanned = false
    /** What the app must send first, and what to answer once it did (from finder.json, per connection). */
    private var expectedApp: String?
    private var secret = ""
    private var verified = false

    override init() {
        super.init()
        let c = FIFinderSyncController.default()
        c.setBadgeImage(Badge.image(symbol: "checkmark", color: NSColor(srgbRed: 0.16, green: 0.69, blue: 0.38, alpha: 1)),
                        label: "Synced", forBadgeIdentifier: "synced")
        c.setBadgeImage(Badge.image(symbol: "arrow.triangle.2.circlepath", color: NSColor(srgbRed: 0.04, green: 0.42, blue: 0.85, alpha: 1)),
                        label: "Syncing", forBadgeIdentifier: "syncing")
        c.setBadgeImage(Badge.image(symbol: "exclamationmark", color: NSColor(srgbRed: 0.84, green: 0.2, blue: 0.27, alpha: 1)),
                        label: "Not synced", forBadgeIdentifier: "error")
        c.directoryURLs = []
        queue.async { self.connect() }
    }

    // MARK: Finder

    override func requestBadgeIdentifier(for url: URL) {
        let p = url.path // not .standardizedFileURL: that turns "/private/tmp/…" into "/tmp/…", which no longer matches
        queue.async {
            self.known[FinderSync.key(p)] = p
            self.ask([p])
        }
    }

    override func endObservingDirectory(at url: URL) {
        let dir = url.path + "/"
        queue.async {
            // Forget what that window showed (one level: deeper items belong to folders still open, or are re-asked).
            self.known = self.known.filter { !($0.value.hasPrefix(dir) && !$0.value.dropFirst(dir.count).contains("/")) }
        }
    }

    // MARK: Talking to Cloudy

    /** Port and secret of the running Cloudy app (the file is in the real home folder, not this sandbox's). */
    private func portFile() -> (port: UInt16, secret: String, app: String)? {
        guard let pw = getpwuid(getuid()), let home = pw.pointee.pw_dir else { return nil }
        let url = URL(fileURLWithPath: String(cString: home)).appendingPathComponent("Library/Application Support/Cloudy/finder.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = obj["port"] as? Int, port > 0, port < 65536,
              let secret = obj["secret"] as? String, let app = obj["app"] as? String else { return nil }
        return (UInt16(port), secret, app)
    }

    private func connect() {
        guard fd < 0 else { return }
        guard let (port, secret, app) = portFile() else { return retryLater() }
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { return retryLater() }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard ok == 0 else { close(s); return retryLater() }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        fd = s
        buffer.removeAll()
        expectedApp = app
        self.secret = secret
        verified = false
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        src.setCancelHandler { close(s) }
        source = src
        src.resume()
        // Nothing is sent before the app proved itself (see handle).
    }

    private func retryLater() {
        queue.asyncAfter(deadline: .now() + 3) { self.connect() }
    }

    private func disconnected() {
        source?.cancel()
        source = nil
        fd = -1
        verified = false
        waiting.removeAll()
        // Cloudy quit: no folders, so no badges that could be wrong.
        DispatchQueue.main.async { FIFinderSyncController.default().directoryURLs = [] }
        retryLater()
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { return disconnected() }
        buffer.append(contentsOf: chunk[0..<n])
        if buffer.count > 16 * 1024 * 1024 { return disconnected() }
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer.removeSubrange(buffer.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(obj) }
        }
    }

    private func handle(_ msg: [String: Any]) {
        if !verified {
            guard let app = msg["app"] as? String, let want = expectedApp, app == want else { return disconnected() }
            verified = true
            guard send(["hello": secret]) else { return disconnected() }
            // Everything Finder already shows is asked again (Cloudy was restarted, or started after Finder).
            if !known.isEmpty { ask(Array(known.values)) }
            return
        }
        if let folders = msg["folders"] as? [String] {
            let urls = Set(folders.map { URL(fileURLWithPath: $0) })
            DispatchQueue.main.async { FIFinderSyncController.default().directoryURLs = urls }
        }
        if let badges = msg["badges"] as? [String: String] {
            DispatchQueue.main.async {
                let c = FIFinderSyncController.default()
                for (p, id) in badges { c.setBadgeIdentifier(id, for: URL(fileURLWithPath: p)) }
            }
        }
        if msg.keys.contains("changed") {
            if let paths = msg["changed"] as? [String] { ask(paths.compactMap { known[FinderSync.key($0)] }) }
            else { ask(Array(known.values)) } // null: everything
        }
    }

    /** One spelling for one item: Finder and the app may write a path differently ("/private/tmp/…" is "/tmp/…", also
     * /var and /etc; a name in another Unicode form or case, which the usual macOS volume treats as the same). */
    static func key(_ p: String) -> String {
        var s = p
        for d in ["/private/tmp/", "/private/var/", "/private/etc/"] where s.hasPrefix(d) { s = String(s.dropFirst("/private".count)); break }
        return s.precomposedStringWithCanonicalMapping.lowercased()
    }

    private func ask(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        waiting.formUnion(paths)
        guard !flushPlanned else { return }
        flushPlanned = true
        queue.asyncAfter(deadline: .now() + 0.05) {
            self.flushPlanned = false
            guard self.fd >= 0, self.verified, !self.waiting.isEmpty else { return }
            let list = Array(self.waiting)
            self.waiting.removeAll()
            // In lines of at most 1,000 (the app reads lines up to a limit; a huge folder must not exceed it).
            for start in stride(from: 0, to: list.count, by: 1000) {
                if !self.send(["ask": Array(list[start..<min(start + 1000, list.count)])]) { return self.disconnected() }
            }
        }
    }

    /** One line to the app; false when the connection is gone. */
    private func send(_ obj: [String: Any]) -> Bool {
        guard fd >= 0, var data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        data.append(0x0A)
        return data.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let w = write(fd, raw.baseAddress! + off, raw.count - off)
                if w <= 0 { return false }
                off += w
            }
            return true
        }
    }
}

/** The badge pictures: a white symbol on a coloured disc with a thin white ring (readable on any icon). */
enum Badge {
    static func image(symbol: String, color: NSColor) -> NSImage {
        let size = NSSize(width: 64, height: 64)
        return NSImage(size: size, flipped: false) { rect in
            NSColor.white.setFill()
            NSBezierPath(ovalIn: rect).fill()
            color.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
            let config = NSImage.SymbolConfiguration(pointSize: 30, weight: .heavy)
                .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
            if let s = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) {
                let r = NSRect(x: rect.midX - s.size.width / 2, y: rect.midY - s.size.height / 2, width: s.size.width, height: s.size.height)
                s.draw(in: r)
            }
            return true
        }
    }
}
