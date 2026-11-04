import SwiftUI

/// Favorites, Recent and Shared with you.
struct NodeListView: View {
    let kind: ListKind
    @State private var nodes: [FileNode]?
    @State private var loadError: String?
    @State private var actions = FileActions()

    var body: some View {
        List(nodes ?? [], selection: $actions.selection) { node in
            FileRow(node: node, actions: actions, subtitle: subtitle(node))
        }
        .environment(\.editMode, .constant(actions.selecting ? .active : .inactive))
        .overlay {
            if let loadError, nodes == nil { ErrorState(message: loadError) { Task { await load() } } }
            else if nodes == nil { ProgressView() }
            else if nodes!.isEmpty { ContentUnavailableView(emptyText, systemImage: icon) }
        }
        .navigationTitle(title)
        .refreshable { await load() }
        .task {
            actions.changed = { Task { await load() } }
            actions.canModify = { $0.owner == Session.shared.user?.id } // others' files: their folder isn't ours to change
            await load()
        }
        .onLiveChange(shares: kind == .shared, any: kind != .shared) { Task { await load() } }
        .fileActions(actions)
        .selectionMode(actions, items: nodes ?? [], canModify: actions.canModify)
    }

    private var title: LocalizedStringKey {
        switch kind {
        case .recent: "Recent"
        case .favorites: "Favorites"
        case .shared: "Shared with you"
        }
    }

    private var emptyText: LocalizedStringKey {
        switch kind {
        case .recent: "No recent files"
        case .favorites: "No favorites yet"
        case .shared: "Nothing shared with you yet"
        }
    }

    private var icon: String {
        switch kind {
        case .recent: "clock"
        case .favorites: "star"
        case .shared: "person.2"
        }
    }

    private func subtitle(_ n: FileNode) -> String? {
        guard kind == .shared, let owner = n.ownerName ?? n.owner else { return nil }
        return String(localized: "From \(owner)")
    }

    private func load() async {
        do {
            switch kind {
            case .recent: nodes = try await API.shared.recent()
            case .favorites: nodes = try await API.shared.favorites()
            case .shared: nodes = try await API.shared.sharedWithMe()
            }
            loadError = nil
        } catch is CancellationError {
        } catch {
            loadError = errorText(error)
        }
    }
}

/// Links and shares the user created ("Shared by you").
struct LinksView: View {
    @State private var shares: [Share]?
    @State private var loadError: String?
    @State private var error: String?
    @State private var sharing: FileNode?

    var body: some View {
        List {
            ForEach(shares ?? []) { s in
                Button {
                    if let n = s.node { sharing = n }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: s.type == "link" ? "link" : s.type == "group" ? "person.3" : "person")
                            .foregroundStyle(.tint).frame(width: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.node?.name ?? "")
                            Text(s.type == "link" ? String(localized: "Public link") : String(localized: "With \(s.shareWith ?? "")"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .onDelete(perform: remove)
        }
        .overlay {
            if let loadError, shares == nil { ErrorState(message: loadError) { Task { await load() } } }
            else if shares == nil { ProgressView() }
            else if shares!.isEmpty { ContentUnavailableView("You haven't shared anything yet", systemImage: "link") }
        }
        .navigationTitle("Shared by you")
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $sharing, onDismiss: { Task { await load() } }) { ShareSheetView(node: $0) }
        .errorAlert($error)
    }

    private func load() async {
        do { shares = try await API.shared.sharedByMe(); loadError = nil } catch { loadError = errorText(error) }
    }

    private func remove(_ offsets: IndexSet) {
        guard let list = shares else { return }
        let ids = offsets.map { list[$0].id }
        shares!.remove(atOffsets: offsets)
        Task {
            do { for id in ids { try await API.shared.deleteShare(id) } } catch { self.error = errorText(error) }
            await load()
        }
    }
}

struct TrashView: View {
    @State private var items: [TrashItem]?
    @State private var loadError: String?
    @State private var error: String?
    @State private var confirmEmpty = false
    @State private var purging: TrashItem?

    var body: some View {
        List(items ?? []) { item in
            let node = FileNode(id: item.id, name: item.name, isDir: item.isDir, size: item.size, mime: item.mime)
            NodeRow(node: node, subtitle: [item.originalPath, formatDate(parseDate(item.deletedAt))].compactMap { $0 }.joined(separator: " · "))
                .swipeActions(edge: .leading) {
                    Button { act { try await API.shared.restore(item.id) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                        .tint(.green)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { purging = item } label: { Label("Delete forever", systemImage: "trash") }
                }
                .contextMenu {
                    Button { act { try await API.shared.restore(item.id) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    Button(role: .destructive) { purging = item } label: { Label("Delete forever", systemImage: "trash") }
                }
        }
        .overlay {
            if let loadError, items == nil { ErrorState(message: loadError) { Task { await load() } } }
            else if items == nil { ProgressView() }
            else if items!.isEmpty { ContentUnavailableView("Trash is empty", systemImage: "trash") }
        }
        .navigationTitle("Trash")
        .toolbar {
            Button("Empty", role: .destructive) { confirmEmpty = true }.disabled(items?.isEmpty ?? true)
        }
        .confirmationDialog("Delete everything in the trash forever?", isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("Empty trash", role: .destructive) { act { try await API.shared.emptyTrash() } }
        }
        .confirmationDialog(Text("\"\(purging?.name ?? "")\" will be deleted forever."),
                            isPresented: Binding(get: { purging != nil }, set: { if !$0 { purging = nil } }), titleVisibility: .visible) {
            Button("Delete forever", role: .destructive) { if let p = purging { act { try await API.shared.purge(p.id) } } }
        }
        .refreshable { await load() }
        .task { await load() }
        .errorAlert($error)
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { self.error = errorText(error) }
            await load()
        }
    }

    private func load() async {
        do { items = try await API.shared.trash(); loadError = nil } catch { loadError = errorText(error) }
    }
}
