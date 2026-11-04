import UIKit
import SwiftUI
import UniformTypeIdentifiers
import Observation

/// "Share to Cloudy": collects the shared files into a temporary folder, then shows `ShareView`, which uploads
/// them with the app's device token (shared Keychain) to a folder on the server the app is signed in to.
final class ShareViewController: UIViewController {
    private let work = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        API.shared.server = UserDefaults(suiteName: appGroup)?.string(forKey: "server") ?? ""
        API.shared.token = Keychain.get("token")
        // The sheet shows at once ("Preparing…"); copying a long video out of Photos can take a while.
        let model = ShareModel()
        present(model)
        Task { model.items = await collect() }
    }

    private func present(_ model: ShareModel) {
        let host = UIHostingController(rootView: ShareView(model: model, signedIn: API.shared.token != nil && !API.shared.server.isEmpty) { [weak self] in
            self?.finish()
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func finish() {
        try? FileManager.default.removeItem(at: work)
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// Copies every attachment that is a file (photos and videos included) into `work`, keeping its name.
    private func collect() async -> [SharedItem] {
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        var out: [SharedItem] = []
        var used = Set<String>()
        for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
            for provider in item.attachments ?? [] {
                guard provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) else { continue }
                guard let src = await file(from: provider) else { continue }
                // The sharing app chooses the name: keep it to one path component inside `work`.
                var name = safeFileName(provider.suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? src.lastPathComponent)
                if !name.contains("."), let ext = src.pathExtension.isEmpty ? nil : src.pathExtension { name += ".\(ext)" }
                var candidate = name, n = 2
                while used.contains(candidate.lowercased()) {
                    let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
                    candidate = ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"
                    n += 1
                }
                used.insert(candidate.lowercased())
                let dest = work.appendingPathComponent(candidate)
                // `src` is already our own copy: move it (a second copy doubled the time and disk space for big videos).
                if (try? FileManager.default.moveItem(at: src, to: dest)) != nil {
                    let size = (try? FileManager.default.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? 0
                    out.append(SharedItem(name: candidate, url: dest, size: size))
                }
            }
        }
        return out
    }

    private func file(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { cont in
            // The URL is only valid inside the handler, so the copy happens here (synchronously).
            provider.loadFileRepresentation(forTypeIdentifier: UTType.data.identifier) { url, _ in
                guard let url else { return cont.resume(returning: nil) }
                let tmp = self.work.appendingPathComponent("in-\(UUID().uuidString)").appendingPathComponent(safeFileName(url.lastPathComponent))
                try? FileManager.default.createDirectory(at: tmp.deletingLastPathComponent(), withIntermediateDirectories: true)
                cont.resume(returning: (try? FileManager.default.copyItem(at: url, to: tmp)) != nil ? tmp : nil)
            }
        }
    }
}

/// The files to upload; nil while they are still being copied out of the sharing app.
@MainActor @Observable
final class ShareModel {
    var items: [SharedItem]?
}

struct SharedItem: Identifiable {
    let id = UUID()
    let name: String
    let url: URL
    let size: Int64
}
