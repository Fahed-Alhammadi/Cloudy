#if DEBUG
import Foundation
import UIKit

/// Debug builds only: opens a screen from the launch environment so App Store screenshots can be taken without
/// tapping (see ios/appstore/README.md). `CLOUDY_OPEN` = `folder:<id>:<name>`, `text:<id>:<name>` or `share:<id>:<name>`
/// (a folder's share sheet); `CLOUDY_CONTACT` = a contact's display name.
/// `CLOUDY_TOUR` = `<folder id>:<folder name>:<text file id>:<text file name>:<contact>` plays a scripted ~25 s walk
/// through the app for the App Store preview video; screens follow it via `.tour` notifications.
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
