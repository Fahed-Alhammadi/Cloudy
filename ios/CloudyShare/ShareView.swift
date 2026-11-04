import SwiftUI

/// The sheet shown by "Share to Cloudy": the files, the destination folder (remembered), and Upload.
struct ShareView: View {
    let model: ShareModel
    let signedIn: Bool
    let done: () -> Void

    @State private var folder = Folder.remembered()
    @State private var uploading = false
    @State private var progress = 0
    @State private var fraction = 0.0
    @State private var finished = false
    @State private var error: String?
    /// Files that are already on the server: "Upload" after an error goes on with the rest.
    @State private var uploaded = Set<UUID>()
    @State private var task: Task<Void, Never>?
    @State private var closed = false

    private var items: [SharedItem] { model.items ?? [] }

    var body: some View {
        NavigationStack {
            List {
                if !signedIn {
                    Section { Label("Sign in to Cloudy first, then share again.", systemImage: "person.crop.circle.badge.exclamationmark") }
                } else if model.items == nil {
                    Section {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Preparing files…").foregroundStyle(.secondary)
                        }
                    }
                } else if items.isEmpty {
                    Section { Label("Nothing to upload", systemImage: "tray") }
                } else {
                    Section("Folder") {
                        NavigationLink {
                            FolderList(id: 0, name: String(localized: "Files")) { folder = $0; folder.remember() }
                        } label: {
                            Label(folder.name, systemImage: "folder").foregroundStyle(.primary)
                        }
                    }
                    Section("Files") {
                        ForEach(items) { item in
                            HStack {
                                Image(systemName: uploaded.contains(item.id) ? "checkmark.circle.fill" : icon(for: item.name))
                                    .foregroundStyle(uploaded.contains(item.id) ? AnyShapeStyle(.green) : AnyShapeStyle(.tint)).frame(width: 24)
                                Text(item.name).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text(item.size.formatted(.byteCount(style: .file))).foregroundStyle(.secondary).font(.footnote)
                            }
                        }
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Upload to Cloudy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Also stops a running upload (a big video can take minutes). The extension may end before the app's
                // DELETE of the partial upload goes out; the server removes unfinished uploads after a day anyway.
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { task?.cancel(); close() } }
                ToolbarItem(placement: .confirmationAction) {
                    if finished {
                        Button("Done", action: close)
                    } else {
                        Button(action: upload) { Text("Upload").bold() }.disabled(!signedIn || items.isEmpty || uploading)
                    }
                }
            }
            .overlay {
                if uploading {
                    VStack(spacing: 12) {
                        ProgressView(value: fraction).frame(width: 200)
                        Text("Uploading \(progress + 1) of \(items.count)…").font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                } else if finished {
                    Label("Uploaded", systemImage: "checkmark.circle.fill").font(.title3).foregroundStyle(.green)
                        .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    /// Ends the extension once: Cancel or Done during the short "Uploaded" pause must not complete the request twice.
    private func close() {
        guard !closed else { return }
        closed = true
        done()
    }

    private func icon(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "jpg", "jpeg", "png", "heic", "gif", "webp": return "photo"
        case "mov", "mp4", "m4v": return "film"
        case "pdf": return "doc.richtext"
        case "zip": return "doc.zipper"
        default: return "doc"
        }
    }

    private func upload() {
        uploading = true
        error = nil
        let count = Double(max(items.count, 1))
        task = Task {
            do {
                let target = folder.id == 0 ? try await rootId() : folder.id
                for (i, item) in items.enumerated() where !uploaded.contains(item.id) {
                    progress = i
                    fraction = Double(i) / count
                    _ = try await API.shared.upload(target, name: item.name, file: item.url) { sent, total in
                        let part = total > 0 ? Double(sent) / Double(total) : 1
                        DispatchQueue.main.async { fraction = (Double(i) + part) / count }
                    }
                    uploaded.insert(item.id)
                }
                finished = true
                // Close by itself once the result was seen; "Done" also works.
                try? await Task.sleep(for: .seconds(1.2))
                close()
            } catch is CancellationError {
            } catch let e as URLError where e.code == .cancelled {
            } catch let e as APIError where e.status == 401 {
                self.error = String(localized: "Sign in to Cloudy first, then share again.") // token revoked or expired
            } catch let e as APIError where e.status == 404 && folder.id != 0 {
                // The remembered folder was deleted (or belongs to another account): pick again.
                folder = Folder(id: 0, name: String(localized: "Files"))
                folder.remember()
                self.error = String(localized: "The folder no longer exists. Choose another one.")
            } catch {
                self.error = errorText(error)
            }
            uploading = false
        }
    }

    private func rootId() async throws -> Int64 {
        let me: User = try await API.shared.get("/api/me")
        return me.rootId ?? 0
    }
}

/// Destination folder; id 0 = the root ("Files").
struct Folder {
    var id: Int64
    var name: String

    static func remembered() -> Folder {
        let d = UserDefaults(suiteName: appGroup)
        let id = d?.object(forKey: "shareFolderId") as? Int64 ?? 0
        return Folder(id: id, name: id == 0 ? String(localized: "Files") : (d?.string(forKey: "shareFolderName") ?? String(localized: "Files")))
    }

    func remember() {
        let d = UserDefaults(suiteName: appGroup)
        d?.set(id, forKey: "shareFolderId")
        d?.set(name, forKey: "shareFolderName")
    }
}

/// Folders inside one folder, each opening the next level; "Choose this folder" picks the one shown.
private struct FolderList: View {
    let id: Int64
    let name: String
    let pick: (Folder) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var folders: [FileNode]?
    @State private var realId: Int64 = 0
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Button { pick(Folder(id: realId, name: name)); dismiss() } label: {
                    Label("Choose this folder", systemImage: "checkmark.circle")
                }
                .disabled(folders == nil)
            }
            if let folders {
                Section {
                    if folders.isEmpty { Text("No folders").foregroundStyle(.secondary) }
                    ForEach(folders) { f in
                        NavigationLink { FolderList(id: f.id, name: f.name, pick: pick) } label: { Label(f.name, systemImage: "folder") }
                    }
                }
            } else if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            } else {
                Section { ProgressView() }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                var target = id
                if target == 0 {
                    let me: User = try await API.shared.get("/api/me")
                    target = me.rootId ?? 0
                }
                realId = target
                let listing = try await API.shared.node(target)
                folders = (listing.children ?? []).filter(\.isDir).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            } catch {
                self.error = errorText(error)
            }
        }
    }
}
