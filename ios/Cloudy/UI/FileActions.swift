import SwiftUI
import QuickLook

/// Per-screen state for acting on files: open (Quick Look), send to other apps, rename, move/copy,
/// favorite, share and delete, one file or several (multi-select, the same as on Android and the web).
/// Attach with `.fileActions(actions)` and `.selectionMode(actions, items:)`; rows use `menu(for:)`.
@Observable
final class FileActions {
    struct Transfer: Identifiable {
        let id = UUID()
        let nodes: [FileNode]
        let copy: Bool
    }

    var renaming: FileNode?
    var renameText = ""
    var transferring: Transfer?
    var sharing: FileNode?
    var deleting: FileNode?
    var deletingMany: [FileNode]?
    var leaving: FileNode?
    /// Whether the user may rename, move or delete a file here (edit on its folder); the screen sets it. Read-only
    /// shares only offer the other actions, the same as on the web and Android.
    var canModify: (FileNode) -> Bool = { _ in true }
    /// Multi-select: started from a file's menu ("Select"); taps then tick files.
    var selecting = false
    var selection = Set<Int64>()
    var downloading: FileNode?
    var previewURL: URL?
    var shareItem: ShareItem?
    var error: String?
    /// Called after a change so the screen reloads (live updates usually do it too).
    var changed: () -> Void = {}
    private var task: Task<Void, Never>?
    private var taskId: UUID?

    /// Downloads (or reuses the cached copy) and shows the file in Quick Look: images, video, audio,
    /// PDF and office documents all preview natively.
    @MainActor
    func open(_ node: FileNode) { fetch(node) { self.previewURL = $0 } }

    /// Hands the file to the share sheet (Save to Files, Mail, Messages, other apps…). Folders go as ZIP.
    @MainActor
    func export(_ node: FileNode) { fetch(node) { self.shareItem = ShareItem(items: [$0]) } }

    @MainActor
    private func fetch(_ node: FileNode, then: @escaping (URL) -> Void) {
        task?.cancel()
        downloading = node
        let me = UUID()
        taskId = me
        task = Task {
            do {
                let url = try await FileCache.fetch(node)
                if !Task.isCancelled { then(url) }
            } catch is CancellationError {
            } catch let e as URLError where e.code == .cancelled {
            } catch {
                self.error = errorText(error)
            }
            // A download that was replaced by a newer one must not hide the newer one's progress.
            if taskId == me { downloading = nil }
        }
    }

    /// Sends several files to the share sheet at once (folders are skipped: they would each become a ZIP).
    @MainActor
    func exportMany(_ nodes: [FileNode]) {
        let files = nodes.filter { !$0.isDir }
        guard let first = files.first else { error = String(localized: "Folders can't be sent. Select files."); return }
        task?.cancel()
        downloading = files.count == 1 ? first : FileNode(id: 0, name: String(localized: "\(files.count) files"), isDir: false)
        let me = UUID()
        taskId = me
        task = Task {
            do {
                var urls: [URL] = []
                for n in files { urls.append(try await FileCache.fetch(n)) }
                if !Task.isCancelled { shareItem = ShareItem(items: urls) }
            } catch is CancellationError {
            } catch let e as URLError where e.code == .cancelled {
            } catch {
                self.error = errorText(error)
            }
            if taskId == me { downloading = nil }
        }
    }

    @MainActor
    func select(_ node: FileNode) {
        withAnimation { selecting = true }
        // A List clears its selection when it switches to edit mode, so tick the file once that has happened.
        DispatchQueue.main.async { self.selection = [node.id] }
    }

    @MainActor
    func endSelection() {
        withAnimation { selecting = false }
        selection = []
    }

    /// Runs `work` on each file, then ends the selection and reloads; reports how many failed.
    @MainActor
    func runEach(_ nodes: [FileNode], _ work: @escaping (FileNode) async throws -> Void) {
        endSelection()
        Task {
            var failed = 0
            for n in nodes {
                do { try await work(n) } catch { failed += 1 }
            }
            if failed > 0 { self.error = String(localized: "\(failed) failed") }
            changed()
        }
    }

    @MainActor
    func cancelDownload() {
        task?.cancel()
        downloading = nil
    }

    @MainActor
    func run(_ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
                changed()
            } catch {
                self.error = errorText(error)
            }
        }
    }

    /// Whether a text file's content may be saved: the server's own answer when the listing has one (shared with you,
    /// search results), otherwise the same edit permission as rename/move/delete.
    func canEditContent(_ node: FileNode) -> Bool { node.canEdit ?? canModify(node) }

    /// Only the owner can share a file (the server answers 403 to everyone else).
    func isOwner(_ node: FileNode) -> Bool { node.owner == nil || node.owner == Session.shared.user?.id }

    /// Context-menu / swipe actions for a row.
    @MainActor @ViewBuilder
    func menu(for node: FileNode) -> some View {
        let modify = canModify(node)
        Button { self.select(node) } label: { Label("Select", systemImage: "checkmark.circle") }
        if !node.isDir {
            Button { self.open(node) } label: { Label("Open", systemImage: "eye") }
        }
        Button { self.export(node) } label: { Label(node.isDir ? "Send as ZIP" : "Send to…", systemImage: "square.and.arrow.up") }
        if isOwner(node) {
            Button { self.sharing = node } label: { Label("Share", systemImage: "person.crop.circle.badge.plus") }
        }
        Button {
            self.run { try await API.shared.setFavorite(node.id, !node.isFavorite) }
        } label: {
            node.isFavorite ? Label("Remove from favorites", systemImage: "star.slash") : Label("Add to favorites", systemImage: "star")
        }
        Divider()
        if modify {
            Button { self.renameText = node.name; self.renaming = node } label: { Label("Rename", systemImage: "pencil") }
            Button { self.transferring = Transfer(nodes: [node], copy: false) } label: { Label("Move", systemImage: "folder") }
        }
        Button { self.transferring = Transfer(nodes: [node], copy: true) } label: { Label("Copy", systemImage: "doc.on.doc") }
        if node.shareId != nil && node.shareType == "user" {
            Button(role: .destructive) { self.leaving = node } label: { Label("Leave share", systemImage: "rectangle.portrait.and.arrow.right") }
        }
        if modify {
            Divider()
            Button(role: .destructive) { self.deleting = node } label: { Label("Delete", systemImage: "trash") }
        }
    }
}

private struct FileActionsModifier: ViewModifier {
    @Bindable var actions: FileActions

    func body(content: Content) -> some View {
        content
            .quickLookPreview($actions.previewURL)
            .sheet(item: $actions.shareItem) { ActivityView(items: $0.items).presentationDetents([.medium, .large]) }
            .sheet(item: $actions.sharing) { ShareSheetView(node: $0) }
            .sheet(item: $actions.transferring) { t in
                FolderPicker(title: t.copy ? "Copy to" : "Move to", action: t.copy ? "Copy here" : "Move here",
                             excluding: Set(t.nodes.map(\.id))) { target in
                    actions.runEach(t.nodes) { n in
                        if t.copy { try await API.shared.copy(n.id, to: target) } else { try await API.shared.move(n.id, to: target) }
                    }
                }
            }
            .alert("Rename", isPresented: Binding(get: { actions.renaming != nil }, set: { if !$0 { actions.renaming = nil } })) {
                TextField("Name", text: $actions.renameText).autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    guard let n = actions.renaming else { return }
                    let name = actions.renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty && name != n.name { actions.run { try await API.shared.rename(n.id, name) } }
                }
            }
            .confirmationDialog(Text("Move \"\(actions.deleting?.name ?? "")\" to the trash?"),
                                isPresented: Binding(get: { actions.deleting != nil }, set: { if !$0 { actions.deleting = nil } }),
                                titleVisibility: .visible) {
                Button("Move to trash", role: .destructive) {
                    if let n = actions.deleting { actions.run { try await API.shared.delete(n.id) } }
                }
            }
            .confirmationDialog(Text("Remove \"\(actions.leaving?.name ?? "")\" from your shared items?"),
                                isPresented: Binding(get: { actions.leaving != nil }, set: { if !$0 { actions.leaving = nil } }),
                                titleVisibility: .visible) {
                Button("Leave share", role: .destructive) {
                    if let id = actions.leaving?.shareId { actions.run { try await API.shared.deleteShare(id) } }
                }
            }
            .confirmationDialog(Text("Move \(actions.deletingMany?.count ?? 0) items to the trash?"),
                                isPresented: Binding(get: { actions.deletingMany != nil }, set: { if !$0 { actions.deletingMany = nil } }),
                                titleVisibility: .visible) {
                Button("Move to trash", role: .destructive) {
                    if let list = actions.deletingMany { actions.runEach(list) { try await API.shared.delete($0.id) } }
                }
            }
            .overlay {
                if let n = actions.downloading {
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Downloading \(n.name)…").font(.callout).multilineTextAlignment(.center)
                        Button("Cancel", role: .cancel) { actions.cancelDownload() }
                    }
                    .padding(24)
                    .frame(maxWidth: 280)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .errorAlert($actions.error)
    }
}

extension View {
    func fileActions(_ actions: FileActions) -> some View { modifier(FileActionsModifier(actions: actions)) }

    /// Multi-select chrome: "N selected" title, Select All / Done, and the action bar at the bottom.
    func selectionMode(_ actions: FileActions, items: [FileNode], canModify: @escaping (FileNode) -> Bool = { _ in true }) -> some View {
        modifier(SelectionModifier(actions: actions, items: items, canModify: canModify))
    }
}

private struct SelectionModifier: ViewModifier {
    @Bindable var actions: FileActions
    let items: [FileNode]
    let canModify: (FileNode) -> Bool

    private var chosen: [FileNode] { items.filter { actions.selection.contains($0.id) } }

    func body(content: Content) -> some View {
        let modifiable = chosen.filter(canModify)
        content
            .toolbar {
                if actions.selecting {
                    ToolbarItem(placement: .principal) {
                        Text("\(actions.selection.count) selected").font(.headline)
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        if actions.selection.count == items.count && !items.isEmpty {
                            Button("Deselect All") { actions.selection = [] }
                        } else {
                            Button("Select All") { actions.selection = Set(items.map(\.id)) }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { actions.endSelection() }
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        Button { actions.exportMany(chosen) } label: { Label("Send to…", systemImage: "square.and.arrow.up") }
                        Spacer()
                        Button { actions.transferring = FileActions.Transfer(nodes: modifiable, copy: false) } label: { Label("Move", systemImage: "folder") }
                            .disabled(modifiable.isEmpty)
                        Spacer()
                        Button { actions.transferring = FileActions.Transfer(nodes: chosen, copy: true) } label: { Label("Copy", systemImage: "doc.on.doc") }
                        Spacer()
                        Button {
                            actions.runEach(chosen.filter { !$0.isFavorite }) { try await API.shared.setFavorite($0.id, true) }
                        } label: { Label("Add to favorites", systemImage: "star") }
                        Spacer()
                        Button(role: .destructive) { actions.deletingMany = modifiable } label: { Label("Delete", systemImage: "trash") }
                            .tint(.red)
                            .disabled(modifiable.isEmpty)
                    }
                }
            }
            .toolbar(actions.selecting ? .hidden : .automatic, for: .tabBar)
            .navigationBarBackButtonHidden(actions.selecting)
            // Files that went away (deleted elsewhere) leave the selection.
            .onChange(of: items.map(\.id)) { _, ids in
                actions.selection.formIntersection(ids)
            }
            .onDisappear { if actions.selecting { actions.endSelection() } }
    }
}

extension FileNode {
    /// Where tapping the row goes: folders and text files push a screen; other files open in Quick Look.
    /// `canEdit`: text files open read-only without it.
    func route(canEdit: Bool) -> Route? {
        if isDir { return .folder(id, name) }
        if isText(self) { return .text(self, canEdit: canEdit) }
        return nil
    }
}

/// The "⋯" button that opens a file's actions (like Android's ⋮).
struct ActionsButton: View {
    let node: FileNode
    let actions: FileActions
    var circle = false

    var body: some View {
        Menu { actions.menu(for: node) } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(circle ? Color.primary : Color.secondary)
                .frame(width: circle ? 30 : 36, height: circle ? 30 : 44)
                .background { if circle { Circle().fill(.regularMaterial) } }
                .frame(width: circle ? 44 : 36, height: 44) // 44 pt touch target around the small grid circle
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text("Actions for \(node.name)"))
    }
}

/// A list row: tap opens (folders and text files push a screen, other files open in Quick Look), "⋯" shows the
/// actions, as do long press and swipe. Folders have no chevron, like on Android.
struct FileRow: View {
    let node: FileNode
    let actions: FileActions
    var subtitle: String?

    var body: some View {
        let content = HStack(spacing: 2) {
            NodeRow(node: node, subtitle: subtitle)
            ActionsButton(node: node, actions: actions)
        }
        Group {
            if actions.selecting {
                // Multi-select: the List (in edit mode) handles the tap and draws the checkmark.
                NodeRow(node: node, subtitle: subtitle)
            } else if let route = node.route(canEdit: actions.canEditContent(node)) {
                // A hidden link makes the whole row tappable without the disclosure chevron.
                ZStack {
                    NavigationLink(value: route) { EmptyView() }.opacity(0)
                    content
                }
            } else {
                Button { actions.open(node) } label: { content }
                    .foregroundStyle(.primary)
            }
        }
        .contextMenu { if !actions.selecting { actions.menu(for: node) } }
        .swipeActions(edge: .trailing) {
            if !actions.selecting {
                if actions.canModify(node) {
                    Button(role: .destructive) { actions.deleting = node } label: { Label("Delete", systemImage: "trash") }
                }
                if actions.isOwner(node) {
                    Button { actions.sharing = node } label: { Label("Share", systemImage: "person.crop.circle.badge.plus") }.tint(.accentColor)
                }
            }
        }
    }
}

/// A grid tile with an image thumbnail (or the file's icon), like Android's NodeGrid.
struct FileTile: View {
    let node: FileNode
    let actions: FileActions
    @State private var image: UIImage?

    var body: some View {
        let tile = VStack(spacing: 6) {
            Color(.secondarySystemGroupedBackground)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        let (icon, color) = fileIcon(node)
                        Image(systemName: icon).font(.system(size: 40)).foregroundStyle(color)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(alignment: .topLeading) {
                    HStack(spacing: 3) {
                        if node.isFavorite { Image(systemName: "star.fill").foregroundStyle(.yellow) }
                        if node.shared == true { Image(systemName: "person.2.fill").foregroundStyle(.secondary) }
                    }
                    .font(.caption2)
                    .padding(6)
                }
            Text(node.name)
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
        .contentShape(Rectangle())
        let isSelected = actions.selection.contains(node.id)
        Group {
            if actions.selecting {
                Button {
                    if isSelected { actions.selection.remove(node.id) } else { actions.selection.insert(node.id) }
                } label: { tile.opacity(isSelected ? 1 : 0.75) }
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            } else if let route = node.route(canEdit: actions.canEditContent(node)) {
                NavigationLink(value: route) { tile }
            } else {
                Button { actions.open(node) } label: { tile }
            }
        }
        .buttonStyle(.plain)
        .contextMenu { if !actions.selecting { actions.menu(for: node) } }
        .overlay(alignment: .topTrailing) {
            if actions.selecting {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(isSelected ? Color.white : Color.secondary, isSelected ? Color.accentColor : Color.clear)
                    .background(Circle().fill(.regularMaterial).opacity(isSelected ? 0 : 1))
                    .padding(6)
                    .allowsHitTesting(false)
            } else {
                ActionsButton(node: node, actions: actions, circle: true)
            }
        }
        .task(id: node.etag) {
            if Thumbnails.supports(node) { image = await Thumbnails.shared.image(for: node) }
        }
    }
}
