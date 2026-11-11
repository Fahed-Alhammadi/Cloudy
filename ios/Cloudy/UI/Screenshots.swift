#if DEBUG
import SwiftUI
import UIKit

/// Debug builds only: opens a screen from the launch environment so App Store screenshots can be taken without
/// tapping (see ios/appstore/README.md). `CLOUDY_OPEN` = `folder:<id>:<name>`, `text:<id>:<name>` or `share:<id>:<name>`
/// (a folder's share sheet); `CLOUDY_CONTACT` = a contact's display name.
/// `CLOUDY_TOUR` = `<folder id>:<folder name>:<text file id>:<text file name>:<contact>` plays a scripted ~25 s walk
/// through the app for the App Store preview video; screens follow it via `.tour` notifications.
/// `CLOUDY_SCRIPT` = `<seconds>:<step>;…` plays any steps, to look at states and motion without tapping:
/// `tab:<n>`, `folder:<id>:<name>`, `text:<id>:<name>`, `route:recent|favorites|shared|links|trash|devices`, `pop`, `grid` (list ↔ grid), `sort:name|date|size|flip`,
/// `select:<n>` (multi-select with the first n files ticked), `done`, `month:<±n>`, `day:<±n>`, `contact:<name>`,
/// `landscape`, `portrait`. Example: `2:tab:1;1:month:1;1:month:-1;1:landscape`.
/// `CLOUDY_LANDSCAPE=1` starts rotated, `CLOUDY_LOCK=1` shows the app-lock screen (and keeps it), `CLOUDY_ICONS=1` shows
/// one row per file type, `CLOUDY_LOGIN_ERROR=<text>` shows the sign-in screen with that error.
enum Screenshots {
    private static let env = ProcessInfo.processInfo.environment

    static func filesPath() -> (path: [Route], share: FileNode?) {
        guard let open = env["CLOUDY_OPEN"] else { return ([], nil) }
        let parts = open.split(separator: ":", maxSplits: 2).map(String.init)
        guard parts.count == 3, let id = Int64(parts[1]) else { return ([], nil) }
        switch parts[0] {
        case "folder": return ([.folder(id, parts[2])], nil)
        case "text": return ([.text(FileNode(id: id, name: parts[2], isDir: false))], nil)
        case "share": return ([], FileNode(id: id, name: parts[2], isDir: true))
        default: return ([], nil)
        }
    }

    static var contact: String? { env["CLOUDY_CONTACT"] }
    static var lock: Bool { env["CLOUDY_LOCK"] != nil }
    static var icons: Bool { env["CLOUDY_ICONS"] != nil }
    static var loginError: String? { env["CLOUDY_LOGIN_ERROR"] }

    /// Turns the window (the simulator can't be rotated from the command line).
    @MainActor static func rotate(landscape: Bool) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        scene?.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeRight : .portrait))
    }

    /// One row per file type, to judge the tiles' glyphs and tints side by side.
    struct IconSamples: View {
        var body: some View {
            let names = ["Folder", "Photo.jpg", "Clip.mp4", "Song.mp3", "Paper.pdf", "Backup.zip", "Budget.xlsx", "Deck.pptx",
                         "Letter.docx", "Notes.txt", "Disk.bin"]
            let mimes = ["Photo.jpg": "image/jpeg", "Clip.mp4": "video/mp4", "Song.mp3": "audio/mpeg", "Paper.pdf": "application/pdf",
                         "Notes.txt": "text/plain"]
            let nodes = names.enumerated().map { i, n in
                FileNode(id: Int64(i + 1), name: n, isDir: i == 0, size: 48_000, mime: mimes[n], favorite: i % 4 == 1, shared: i % 5 == 2)
            }
            NavigationStack {
                List(nodes) { NodeRow(node: $0) }.navigationTitle(Text(verbatim: "File types"))
            }
        }
    }

    /// `CLOUDY_SHARE_TEST=1`: opens the system share sheet with a small text file, to check that the "Cloudy"
    /// share extension is offered and works (simulator testing).
    @MainActor static func shareTest() {
        guard env["CLOUDY_SHARE_TEST"] != nil else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("share-test.txt")
        try? "hello from the share sheet".write(to: url, atomically: true, encoding: .utf8)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            guard let root = scene?.keyWindow?.rootViewController else { return }
            var top = root
            while let p = top.presentedViewController { top = p }
            top.present(UIActivityViewController(activityItems: [url], applicationActivities: nil), animated: true)
        }
    }

    enum Step {
        case tab(Int)
        case files([Route])
        case share(FileNode?)
        case month(Int)
        case day(Int)
        case contact(String?)
        case type(String)
        case grid
        case sort(String)
        case select(Int)
        case done
    }

    /// Things to do once the first screen is up: rotate, play `CLOUDY_SCRIPT`.
    static func start() async {
        if env["CLOUDY_LANDSCAPE"] != nil {
            try? await Task.sleep(nanoseconds: 300_000_000)
            await rotate(landscape: true)
        }
        for item in (env["CLOUDY_SCRIPT"] ?? "").split(separator: ";") {
            let p = item.split(separator: ":", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            guard p.count >= 2, let wait = Double(p[0]) else { continue }
            let arg = p.count > 2 ? p[2] : "", name = p.count > 3 ? p[3] : ""
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            var step: Step?
            switch p[1] {
            case "tab": step = .tab(Int(arg) ?? 0)
            case "folder": step = .files([.folder(Int64(arg) ?? 0, name)])
            case "text": step = .files([.text(FileNode(id: Int64(arg) ?? 0, name: name, isDir: false))])
            case "route":
                let routes: [String: Route] = ["links": .links, "trash": .trash, "devices": .devices]
                step = (ListKind(rawValue: arg).map { .list($0) } ?? routes[arg]).map { .files([$0]) }
            case "pop": step = .files([])
            case "grid": step = .grid
            case "sort": step = .sort(arg)
            case "select": step = .select(Int(arg) ?? 1)
            case "done": step = .done
            case "month": step = .month(Int(arg) ?? 1)
            case "day": step = .day(Int(arg) ?? 0)
            case "contact": step = .contact(arg.isEmpty ? nil : arg)
            case "landscape", "portrait": await rotate(landscape: p[1] == "landscape")
            default: break
            }
            if let step { await MainActor.run { NotificationCenter.default.post(name: .tour, object: step) } }
        }
    }

    /// Starts the tour if `CLOUDY_TOUR` is set; waits a few seconds first so the recording can start.
    static func runTour() async {
        guard let tour = env["CLOUDY_TOUR"] else { return }
        let p = tour.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 5, let folderId = Int64(p[0]), let textId = Int64(p[2]) else { return }
        let folder = FileNode(id: folderId, name: p[1], isDir: true)
        let text = FileNode(id: textId, name: p[3], isDir: false)
        let script: [(Double, Step)] = [
            (2.5, .files([.folder(folderId, p[1])])),
            (3.0, .share(folder)),
            (3.5, .share(nil)),
            (1.0, .files([])),
            (1.0, .tab(1)),
            (2.0, .day(2)),
            (1.5, .month(1)),
            (1.8, .month(-1)),
            (0.3, .day(0)),
            (0.9, .tab(2)),
            (1.5, .contact(p[4])),
            (2.5, .contact(nil)),
            (0.8, .tab(0)),
            (0.7, .files([.text(text)])),
            (1.5, .type("\n## Call\n- Amira about the launch")),
        ]
        for (wait, step) in script {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            await MainActor.run { NotificationCenter.default.post(name: .tour, object: step) }
        }
    }
}

extension Notification.Name {
    static let tour = Notification.Name("cloudyTour")
}
#endif
