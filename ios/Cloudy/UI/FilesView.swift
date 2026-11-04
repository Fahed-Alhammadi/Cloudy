import SwiftUI
import PhotosUI
import VisionKit

enum ListKind: String, Hashable { case recent, favorites, shared }

enum Route: Hashable {
    case folder(Int64, String)
    /// `canEdit`: the user may save changes (false in read-only shares, where saving would get a 403).
    case text(FileNode, canEdit: Bool = true)
    case list(ListKind)
    case links
    case trash
}

struct FilesTab: View {
    @Environment(Session.self) private var session
    @State private var path: [Route] = []
    @State private var sharing: FileNode?

    var body: some View {
        NavigationStack(path: $path) {
            FolderView(id: session.rootId, title: String(localized: "Files"))
                .id(session.rootId)
                .withRoutes()
        }
        #if DEBUG
        .task { (path, sharing) = Screenshots.filesPath() }
        .sheet(item: $sharing) { ShareSheetView(node: $0) }
        .onReceive(NotificationCenter.default.publisher(for: .tour)) { note in
            switch note.object as? Screenshots.Step {
            case .files(let p): path = p
            case .share(let n): sharing = n
            default: break
            }
        }
        #endif
    }
}

extension View {
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .folder(let id, let name): FolderView(id: id, title: name)
            case .text(let node, let canEdit): TextFileView(node: node, canEdit: canEdit)
            case .list(let kind): NodeListView(kind: kind)
            case .links: LinksView()
            case .trash: TrashView()
            }
        }
    }
}

enum SortOrder: String, CaseIterable { case name, date, size }

/// Search filters, the same as Android's TypeFilter.
enum TypeFilter: String, CaseIterable, Hashable {
    case all, folders, images, videos, audio, documents

    var label: LocalizedStringKey {
        switch self {
        case .all: "All"
        case .folders: "Folders"
        case .images: "Images"
        case .videos: "Videos"
        case .audio: "Audio"
        case .documents: "Documents"
        }
    }

    func matches(_ n: FileNode) -> Bool {
        let mime = n.mime ?? ""
        switch self {
        case .all: return true
        case .folders: return n.isDir
        case .images: return mime.hasPrefix("image/")
        case .videos: return mime.hasPrefix("video/")
        case .audio: return mime.hasPrefix("audio/")
        case .documents:
            return !n.isDir && mime.range(of: "pdf|^text/|json|xml|msword|officedocument|opendocument|rtf|presentation|spreadsheet",
                                          options: .regularExpression) != nil
        }
    }
}

struct FolderView: View {
    let id: Int64
    let title: String

    @Environment(Uploads.self) private var uploads
    @AppStorage("sort") private var sort = SortOrder.name
    @AppStorage("sortDescending") private var descending = false
    @AppStorage("grid") private var grid = false
    @State private var listing: NodeListing?
    @State private var loadError: String?
    @State private var actions = FileActions()
    @State private var query = ""
    @State private var results: [FileNode]?
    @State private var searchError: String?
    @State private var filter = TypeFilter.all
    @State private var newFolder = false
    @State private var newText = false
    @State private var newName = ""
    @State private var openText: FileNode?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var importing = false
    @State private var scanning = false
    @State private var scannedPDF: URL? // a scan waiting for its name
    @State private var namingScan = false

    var body: some View {
        content
            .overlay {
                if let loadError, listing == nil {
                    ErrorState(message: loadError) { Task { await load() } }
                } else if listing == nil {
                    ProgressView()
                } else if let searchError, results != nil && shown.isEmpty {
                    ErrorState(message: searchError) { Task { await search(debounce: false) } }
                } else if results != nil && shown.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if results == nil && shown.isEmpty && uploads.jobs(in: id).isEmpty {
                    ContentUnavailableView("This folder is empty", systemImage: "folder",
                                           description: Text("Tap + to upload files or create a folder."))
                }
            }
            // Round "+" at the bottom, like Android's floating button.
            .overlay(alignment: .bottomTrailing) {
                if canEdit && results == nil && !actions.selecting { addButton.padding(20) }
            }
            .navigationTitle(title)
            .searchable(text: $query, prompt: Text("Search all files"))
            .searchScopes($filter, activation: .onSearchPresentation) {
                ForEach(TypeFilter.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .task(id: query) { await search() }
            .refreshable { await load() }
            .task {
                actions.changed = { Task { await load() } }
                actions.canModify = { _ in canEdit } // read-only shares: no rename, move or delete (like web and Android)
                await load()
            }
            .onLiveChange(folders: [id]) { Task { await load() } }
            .toolbar {
                if !actions.selecting { viewButtons }
            }
            .selectionMode(actions, items: shown, canModify: { _ in canEdit })

        .fileActions(actions)
        .textPrompt("New folder", isPresented: $newFolder, text: $newName, action: "Create") { name in
            actions.run { _ = try await API.shared.mkdir(id, name) }
        }
        .textPrompt("New text file", isPresented: $newText, text: $newName, action: "Create") { name in
            let file = name.contains(".") ? name : name + ".txt"
            actions.run { openText = try await API.shared.createTextFile(id, file) }
        }
        .navigationDestination(item: $openText) { TextFileView(node: $0) }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await uploadPhotos(items) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { uploadFiles(urls) }
        }
        .fullScreenCover(isPresented: $scanning, onDismiss: {
            // Ask for a name once the camera is gone (an alert can't show while the cover is dismissing).
            guard scannedPDF != nil else { return }
            newName = String(localized: "Scan \(scanStamp.string(from: Date()))")
            namingScan = true
        }) {
            DocumentScanner { pdf in
                scannedPDF = pdf
                scanning = false
            }
            .ignoresSafeArea()
        }
        .textPrompt("Save scan as PDF", isPresented: $namingScan, text: $newName, action: "Upload") { name in
            guard let pdf = scannedPDF else { return }
            scannedPDF = nil
            uploads.start(pdf, name: name.lowercased().hasSuffix(".pdf") ? name : name + ".pdf", parentId: id)
        }
        .onChange(of: namingScan) { _, open in
            // Cancelled: drop the scan (Upload clears scannedPDF before the alert closes).
            if !open, let pdf = scannedPDF { try? FileManager.default.removeItem(at: pdf); scannedPDF = nil }
        }
    }

    private var canEdit: Bool { listing?.canEdit ?? true }

    /// Search results are always a list (with their folder path); the folder itself is a list or a grid.
    @ViewBuilder
    private var content: some View {
        let jobs = query.isEmpty ? uploads.jobs(in: id) : []
        if grid && results == nil {
            ScrollView {
                VStack(spacing: 12) {
                    if listing?.perm == "read" {
                        Label("Shared with you as read-only", systemImage: "lock")
                            .font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(jobs) { job in UploadRow(job: job) }
                }
                .padding(.horizontal)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 14)], spacing: 18) {
                    ForEach(shown) { node in FileTile(node: node, actions: actions) }
                }
                .padding(.horizontal)
                .padding(.bottom, 90) // room for the + button
            }
            .background(Color(.systemGroupedBackground))
        } else {
            List(selection: $actions.selection) {
                if !jobs.isEmpty {
                    Section("Uploading") {
                        ForEach(jobs) { job in UploadRow(job: job) }
                    }
                }
                Section {
                    ForEach(shown) { node in
                        FileRow(node: node, actions: actions, subtitle: results != nil ? node.path : nil)
                    }
                } header: {
                    if listing?.perm == "read" && results == nil {
                        Label("Shared with you as read-only", systemImage: "lock").textCase(nil)
                    }
                } footer: {
                    Color.clear.frame(height: 60) // room for the + button
                }
            }
            .environment(\.editMode, .constant(actions.selecting ? .active : .inactive))
        }
    }

    @ToolbarContentBuilder
    private var viewButtons: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button { withAnimation { grid.toggle() } } label: {
                grid ? Label("List view", systemImage: "list.bullet") : Label("Grid view", systemImage: "square.grid.2x2")
            }
            sortMenu
        }
    }

    private var shown: [FileNode] {
        if let results { return results.filter(filter.matches) }
        let items = listing?.children ?? []
        return items.sorted { a, b in
            if a.isDir != b.isDir { return a.isDir }
            let asc: Bool
            switch sort {
            case .name: asc = a.name.localizedStandardCompare(b.name) == .orderedAscending
            case .date: asc = (a.modified ?? .distantPast) < (b.modified ?? .distantPast)
            case .size: asc = a.bytes < b.bytes
            }
            return descending ? !asc : asc
        }
    }

    private var addButton: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Upload photos or videos", systemImage: "photo.on.rectangle") }
            Button { importing = true } label: { Label("Upload files", systemImage: "doc.badge.plus") }
            if VNDocumentCameraViewController.isSupported {
                Button { scanning = true } label: { Label("Scan document", systemImage: "doc.viewfinder") }
            }
            Divider()
            Button { newName = ""; newFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus") }
            Button { newName = ""; newText = true } label: { Label("New text file", systemImage: "doc.plaintext") }
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 58, height: 58)
                .background(Circle().fill(Color.accentColor))
                .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
        }
        .accessibilityLabel(Text("Add"))
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: $sort) {
                Text("Name").tag(SortOrder.name)
                Text("Date").tag(SortOrder.date)
                Text("Size").tag(SortOrder.size)
            }
            Toggle("Descending", isOn: $descending)
        } label: {
            Label("Sort", systemImage: "arrow.up.arrow.down")
        }
        .menuActionDismissBehavior(.disabled)
    }

    private func load() async {
        do {
            listing = try await API.shared.node(id)
            loadError = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            loadError = errorText(error)
        }
    }

    private func search(debounce: Bool = true) async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { results = nil; searchError = nil; return }
        if debounce { try? await Task.sleep(nanoseconds: 300_000_000) } // debounce typing
        guard !Task.isCancelled else { return }
        do {
            let found = try await API.shared.search(q)
            guard !Task.isCancelled else { return } // a newer query is on its way
            results = found
            searchError = nil
        } catch {
            // Typing on cancels the previous request: that is not "no results".
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
            results = []
            searchError = errorText(error)
        }
    }

    private func uploadPhotos(_ items: [PhotosPickerItem]) async {
        let stamp = fileStamp.string(from: Date())
        for (i, item) in items.enumerated() {
            do {
                guard let picked = try await item.loadTransferable(type: PickedFile.self) else { continue }
                let ext = picked.url.pathExtension.isEmpty ? (item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg") : picked.url.pathExtension
                let name = "IMG_\(stamp)" + (items.count > 1 ? "_\(i + 1)" : "") + ".\(ext.lowercased())"
                uploads.start(picked.url, name: name, parentId: id)
            } catch {
                actions.error = errorText(error)
            }
        }
    }

    /// Copies each picked file into tmp first (the picked URL is only readable for a while), off the main thread:
    /// copying a large video from iCloud Drive or a USB drive takes seconds and froze the screen.
    private func uploadFiles(_ urls: [URL]) {
        let folder = id
        Task {
            for url in urls {
                do {
                    let copy = try await Task.detached(priority: .userInitiated) { () throws -> URL in
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        let copy = FileCache.tempURL(url.lastPathComponent)
                        try FileManager.default.copyItem(at: url, to: copy)
                        return copy
                    }.value
                    uploads.start(copy, name: url.lastPathComponent, parentId: folder)
                } catch {
                    actions.error = errorText(error)
                }
            }
        }
    }
}

private struct UploadRow: View {
    let job: Uploads.Job
    @Environment(Uploads.self) private var uploads

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: job.error == nil ? "arrow.up.circle" : "exclamationmark.circle")
                .font(.title2).foregroundStyle(job.error == nil ? Color.accentColor : .red).frame(width: 32)
            VStack(alignment: .leading, spacing: 4) {
                Text(job.name).lineLimit(1)
                if let error = job.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                } else {
                    ProgressView(value: job.fraction)
                }
            }
            // Stops a running upload, or clears a failed one from the list.
            Button { uploads.dismiss(job.id) } label: {
                Image(systemName: "xmark").foregroundStyle(.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(job.error == nil ? Text("Cancel upload") : Text("Dismiss"))
        }
    }
}
