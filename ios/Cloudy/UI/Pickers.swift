import SwiftUI
import CoreTransferable
import UniformTypeIdentifiers
import VisionKit

/// `20261024_101530`, for names of uploaded photos and scans.
let fileStamp: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd_HHmmss"
    return f
}()

/// `2026-10-24 13.05`, the default name of a scan (same as Android).
let scanStamp: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH.mm"
    return f
}()

/// A photo or video from the Photos picker, copied to a temporary file (no photo-library permission needed).
struct PickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { try copy($0.file) }
        FileRepresentation(importedContentType: .image) { try copy($0.file) }
        FileRepresentation(importedContentType: .data) { try copy($0.file) }
    }

    private static func copy(_ file: URL) throws -> PickedFile {
        let dest = FileCache.tempURL(file.lastPathComponent)
        try FileManager.default.copyItem(at: file, to: dest)
        return PickedFile(url: dest)
    }
}

/// Chooses a destination folder for move/copy, starting at the user's root.
struct FolderPicker: View {
    let title: LocalizedStringKey
    let action: LocalizedStringKey
    var excluding: Set<Int64> = []
    let onPick: (Int64) -> Void

    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PickerFolder(id: session.rootId, name: String(localized: "Files"), action: action, excluding: excluding) { id in
                onPick(id)
                dismiss()
            }
            .navigationDestination(for: Crumb.self) { c in
                PickerFolder(id: c.id, name: c.name, action: action, excluding: excluding) { id in
                    onPick(id)
                    dismiss()
                }
                // Deeper levels have Back where the first one has Cancel; the way out of the sheet stays on screen.
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } } }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .principal) { Text(title).font(.headline) }
            }
        }
    }
}

private struct PickerFolder: View {
    let id: Int64
    let name: String
    let action: LocalizedStringKey
    let excluding: Set<Int64>
    let onPick: (Int64) -> Void
    @State private var folders: [FileNode]?
    @State private var error: String?

    var body: some View {
        List(folders ?? []) { f in
            NavigationLink(value: Crumb(id: f.id, name: f.name)) {
                HStack(spacing: 12) {
                    TypeTile(node: f, size: 32)
                    Text(f.name).lineLimit(2)
                }
            }
            .disabled(excluding.contains(f.id))
        }
        .overlay {
            if let error { ErrorState(message: error) { Task { await load() } } }
            else if folders == nil { ProgressView() }
            else if folders!.isEmpty {
                ContentUnavailableView("No folders in here", systemImage: "folder")
            }
        }
        .groupedBackground()
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button { onPick(id) } label: { Text(action).bold().frame(maxWidth: .infinity) }
                .primaryButton().padding()
                .background(.bar)
        }
        .task { await load() }
    }

    private func load() async {
        do {
            folders = (try await API.shared.node(id).children ?? []).filter(\.isDir)
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }
}

/// VisionKit document camera; returns a PDF of the scanned pages (nil when cancelled).
struct DocumentScanner: UIViewControllerRepresentable {
    let done: (URL?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let vc = VNDocumentCameraViewController()
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let done: (URL?) -> Void
        init(done: @escaping (URL?) -> Void) { self.done = done }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let url = FileCache.tempURL("Scan_\(fileStamp.string(from: Date())).pdf")
            let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792) // US Letter at 72 dpi; pages are fitted inside
            let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
            do {
                try renderer.writePDF(to: url) { ctx in
                    for i in 0..<scan.pageCount {
                        let img = scan.imageOfPage(at: i)
                        let scale = min(pageRect.width / img.size.width, pageRect.height / img.size.height)
                        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
                        ctx.beginPage(withBounds: CGRect(origin: .zero, size: size), pageInfo: [:])
                        img.draw(in: CGRect(origin: .zero, size: size))
                    }
                }
                done(url)
            } catch {
                done(nil)
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { done(nil) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { done(nil) }
    }
}
