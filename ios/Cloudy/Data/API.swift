import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// [twoFactor] is true when the server asks for (or rejected) a two-factor code.
struct APIError: LocalizedError {
    var status: Int
    var message: String
    var twoFactor = false
    var errorDescription: String? { message }
}

/// Client for the Cloudy JSON API (bearer device token; same contract as Android's data/Api.kt).
final class API: @unchecked Sendable {
    static let shared = API()

    /// Set by `Session`; read on any thread.
    var server = ""
    var token: String?
    var onUnauthorized: () -> Void = {}

    let http: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 60 * 60 * 6
        c.waitsForConnectivity = false
        c.httpCookieStorage = nil // bearer only: never pick up a web session cookie
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func url(_ path: String, server: String? = nil) throws -> URL {
        let base = (server ?? self.server).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let u = URL(string: base + path), u.scheme != nil, u.host != nil else {
            throw APIError(status: 0, message: String(localized: "Invalid server address"))
        }
        return u
    }

    private func request(_ method: String, _ path: String, server: String? = nil) throws -> URLRequest {
        var req = URLRequest(url: try url(path, server: server))
        req.httpMethod = method
        req.setValue("1", forHTTPHeaderField: "X-Cloudy-Request")
        if server == nil, let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    /// Checks the status and turns `{error}` bodies into `APIError`.
    private func check(_ data: Data, _ res: URLResponse, path: String) throws {
        guard let http = res as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 && !path.hasPrefix("/api/auth/") {
                let cb = onUnauthorized
                DispatchQueue.main.async { cb() }
            }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = body?["error"] as? String ?? "HTTP \(http.statusCode)"
            throw APIError(status: http.statusCode, message: msg, twoFactor: body?["twoFactor"] as? Bool ?? false)
        }
    }

    @discardableResult
    func send(_ method: String, _ path: String, body: Data? = nil, contentType: String? = nil,
              headers: [String: String] = [:], server: String? = nil) async throws -> Data {
        var req = try request(method, path, server: server)
        if let body {
            req.httpBody = body
            req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        } else if ["POST", "PUT", "PATCH"].contains(method) {
            req.httpBody = Data()
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let (data, res) = try await http.data(for: req)
        try check(data, res, path: path)
        return data
    }

    @discardableResult
    func sendJSON(_ method: String, _ path: String, _ body: [String: Any?] = [:]) async throws -> Data {
        let clean = body.mapValues { $0 ?? NSNull() }
        return try await send(method, path, body: try JSONSerialization.data(withJSONObject: clean), contentType: "application/json")
    }

    func get<T: Decodable>(_ path: String) async throws -> T { try decode(await send("GET", path)) }
    func decode<T: Decodable>(_ data: Data) throws -> T { try decoder.decode(T.self, from: data) }
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }

    // MARK: auth

    static var deviceName: String {
        #if os(iOS)
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return "\(UIDevice.current.model) (\(machine))"
        #else
        return "Mac (\(Host.current().localizedName ?? "Mac"))"
        #endif
    }

    func login(server: String, user: String, password: String, code: String?) async throws -> TokenResponse {
        var body: [String: Any?] = ["user": user, "password": password, "deviceName": API.deviceName]
        if let code, !code.isEmpty { body["code"] = code.trimmingCharacters(in: .whitespaces) }
        let data = try await send("POST", "/api/auth/token",
                                  body: try JSONSerialization.data(withJSONObject: body.mapValues { $0 ?? NSNull() }),
                                  contentType: "application/json", server: server)
        return try decode(data)
    }

    func logout() async { _ = try? await send("POST", "/api/auth/revoke") }
    func me() async throws -> User { try await get("/api/me") }
    func appPasswords() async throws -> [AppPassword] { try await get("/api/me/app-passwords") }
    func revokeAppPassword(_ id: Int64) async throws { try await send("DELETE", "/api/me/app-passwords/\(id)") }

    // MARK: files

    func node(_ id: Int64) async throws -> NodeListing { try await get("/api/nodes/\(id)") }
    func mkdir(_ parentId: Int64, _ name: String) async throws -> FileNode {
        try decode(await sendJSON("POST", "/api/nodes/\(parentId)/folders", ["name": name]))
    }
    func rename(_ id: Int64, _ name: String) async throws { try await sendJSON("PATCH", "/api/nodes/\(id)", ["name": name]) }
    func move(_ id: Int64, to parentId: Int64) async throws { try await sendJSON("PATCH", "/api/nodes/\(id)", ["parentId": parentId]) }
    func copy(_ id: Int64, to parentId: Int64) async throws { try await sendJSON("POST", "/api/nodes/\(id)/copy", ["parentId": parentId]) }
    func delete(_ id: Int64) async throws { try await send("DELETE", "/api/nodes/\(id)") }
    func setFavorite(_ id: Int64, _ fav: Bool) async throws { try await send(fav ? "POST" : "DELETE", "/api/nodes/\(id)/favorite") }
    func recent() async throws -> [FileNode] { try await get("/api/recent") }
    func favorites() async throws -> [FileNode] { try await get("/api/favorites") }
    func search(_ q: String) async throws -> [FileNode] { try await get("/api/search?q=\(enc(q))") }
    func sharedWithMe() async throws -> [FileNode] { try await get("/api/shares/incoming") }
    func sharedByMe() async throws -> [Share] { try await get("/api/shares/outgoing") }

    func trash() async throws -> [TrashItem] { try await get("/api/trash") }
    func restore(_ id: Int64) async throws { try await send("POST", "/api/trash/\(id)/restore") }
    func purge(_ id: Int64) async throws { try await send("DELETE", "/api/trash/\(id)") }
    func emptyTrash() async throws { try await send("DELETE", "/api/trash") }

    func createTextFile(_ parentId: Int64, _ name: String) async throws -> FileNode {
        try decode(await sendJSON("POST", "/api/nodes/\(parentId)/files", ["name": name, "content": ""]))
    }
    func downloadText(_ id: Int64) async throws -> String {
        String(decoding: try await send("GET", "/api/nodes/\(id)/download?inline"), as: UTF8.self)
    }
    func saveText(_ id: Int64, _ text: String) async throws {
        try await send("PUT", "/api/nodes/\(id)/content", body: Data(text.utf8), contentType: "text/plain; charset=utf-8")
    }

    // MARK: shares

    func shares(_ nodeId: Int64) async throws -> [Share] { try await get("/api/nodes/\(nodeId)/shares") }
    /// `expires`: last day the link works; `canEdit`: visitors may upload (folders only).
    func createLink(_ nodeId: Int64, password: String?, expires: Date?, canEdit: Bool) async throws -> Share {
        var b: [String: Any?] = ["type": "link"]
        if let password, !password.isEmpty { b["password"] = password }
        if let expires { b["expiresAt"] = dayFormatter.string(from: expires) + "T23:59:59" }
        if canEdit { b["canEdit"] = true }
        return try decode(await sendJSON("POST", "/api/nodes/\(nodeId)/shares", b))
    }
    func shareWith(_ nodeId: Int64, target: String, group: Bool, canEdit: Bool) async throws {
        try await sendJSON("POST", "/api/nodes/\(nodeId)/shares", ["type": group ? "group" : "user", "shareWith": target, "canEdit": canEdit])
    }
    func deleteShare(_ id: Int64) async throws { try await send("DELETE", "/api/shares/\(id)") }
    func sharees(_ q: String) async throws -> Sharees { try await get("/api/sharees?q=\(enc(q))") }
    func publicURL(_ share: Share) -> URL? { share.url.flatMap { try? url($0) } }

    // MARK: transfer

    /// Downloads a file (folders come as ZIP) to `dest`, replacing it.
    func download(_ id: Int64, to dest: URL) async throws {
        let req = try request("GET", "/api/nodes/\(id)/download")
        let (tmp, res) = try await http.download(for: req)
        if let h = res as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
            throw APIError(status: h.statusCode, message: String(localized: "Download failed (HTTP \(h.statusCode))"))
        }
        let fm = FileManager.default
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: tmp, to: dest)
    }

    /// Resumable chunked upload of a local file; returns the new node id.
    func upload(_ parentId: Int64, name: String, file: URL, progress: @escaping (Int64, Int64) -> Void) async throws -> Int64 {
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
        let s: UploadSession = try decode(await sendJSON("POST", "/api/uploads", ["parentId": parentId, "name": name, "size": size]))
        let fh = try FileHandle(forReadingFrom: file)
        defer { try? fh.close() }
        var offset: Int64 = 0
        while true {
            try Task.checkCancellation()
            try fh.seek(toOffset: UInt64(offset))
            let chunk = try fh.read(upToCount: s.chunkSize) ?? Data()
            var attempt = 0
            var result: ChunkResult?
            while result == nil {
                do {
                    result = try decode(await send("PUT", "/api/uploads/\(s.id)", body: chunk, headers: ["Upload-Offset": String(offset)]))
                } catch let e as URLError where e.code != .cancelled {
                    attempt += 1
                    if attempt > 5 { throw e }
                    try await Task.sleep(nanoseconds: UInt64(1 << attempt) * 1_000_000_000)
                }
            }
            offset = result!.received
            progress(offset, size)
            if result!.done, let node = result!.node { return node.id }
            if chunk.isEmpty { throw APIError(status: 0, message: String(localized: "File ended before the declared size")) }
        }
    }

    // MARK: live updates (Server-Sent Events); returns when the stream ends

    func streamEvents(_ onEvent: (ChangeEvent) -> Void) async throws {
        var req = try request("GET", "/api/events")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 70 // the server pings every 25 s
        let (bytes, res) = try await http.bytes(for: req)
        if let h = res as? HTTPURLResponse, h.statusCode != 200 { throw APIError(status: h.statusCode, message: "HTTP \(h.statusCode)") }
        var event = ""
        // `lines` skips blank lines, so each `data:` line (one JSON object) is dispatched on its own.
        for try await line in bytes.lines {
            if line.hasPrefix("event:") {
                event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                if event == "change", let ev = try? decoder.decode(ChangeEvent.self, from: Data(line.dropFirst(5).utf8)) { onEvent(ev) }
                event = ""
            }
        }
    }

    // MARK: calendar & contacts

    func calendars() async throws -> [DavCollection] { try await get("/api/calendars") }
    func events(_ calendarId: Int64, from: Date, to: Date) async throws -> [CalEvent] {
        try await get("/api/calendars/\(calendarId)/events?start=\(enc(isoString(from)))&end=\(enc(isoString(to)))")
    }
    func createEvent(_ calendarId: Int64, _ e: EventInput) async throws {
        try await send("POST", "/api/calendars/\(calendarId)/events", body: try encoder.encode(e), contentType: "application/json")
    }
    func updateEvent(_ calendarId: Int64, uri: String, _ e: EventInput) async throws {
        try await send("PUT", "/api/calendars/\(calendarId)/events/\(enc(uri))", body: try encoder.encode(e), contentType: "application/json")
    }
    func deleteEvent(_ calendarId: Int64, uri: String) async throws { try await send("DELETE", "/api/calendars/\(calendarId)/events/\(enc(uri))") }

    func addressBooks() async throws -> [DavCollection] { try await get("/api/addressbooks") }
    func contacts(_ bookId: Int64) async throws -> [Contact] { try await get("/api/addressbooks/\(bookId)/contacts") }
    func saveContact(_ bookId: Int64, _ c: Contact) async throws {
        let body: [String: Any?] = ["givenName": c.givenName, "familyName": c.familyName, "org": c.org, "title": c.title,
                                    "address": c.address, "birthday": c.birthday, "note": c.note,
                                    "emails": c.emails, "phones": c.phones]
        if c.uri.isEmpty { try await sendJSON("POST", "/api/addressbooks/\(bookId)/contacts", body) }
        else { try await sendJSON("PUT", "/api/addressbooks/\(bookId)/contacts/\(enc(c.uri))", body) }
    }
    func deleteContact(_ bookId: Int64, uri: String) async throws { try await send("DELETE", "/api/addressbooks/\(bookId)/contacts/\(enc(uri))") }
    /// Imports a .vcf or .csv file into an address book.
    func importContacts(_ bookId: Int64, _ data: Data) async throws -> ImportResult {
        try decode(await send("POST", "/api/addressbooks/\(bookId)/import", body: data))
    }
    func exportContacts(_ bookId: Int64) async throws -> Data { try await send("GET", "/api/addressbooks/\(bookId)/export") }
}

/// User-facing text for any error (server message, network problem, ATS block).
func errorText(_ error: Error) -> String {
    if let e = error as? URLError {
        switch e.code {
        case .appTransportSecurityRequiresSecureConnection:
            return String(localized: "This server needs an https:// address. Plain http:// only works on your local network.")
        case .notConnectedToInternet: return String(localized: "You're offline")
        case .cannotFindHost, .cannotConnectToHost, .timedOut: return String(localized: "Can't reach the server")
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot, .secureConnectionFailed:
            return String(localized: "The server's HTTPS certificate isn't trusted")
        default: break
        }
    }
    return error.localizedDescription
}
