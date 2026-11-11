import SwiftUI

/// Public links and shares with people/groups for one file or folder.
struct ShareSheetView: View {
    let node: FileNode
    @Environment(\.dismiss) private var dismiss
    @State private var shares: [Share]?
    @State private var error: String?
    // new link
    @State private var password = ""
    @State private var expires = false
    @State private var expiry = Calendar.current.date(byAdding: .day, value: 7, to: Date())!
    @State private var allowUpload = false
    @State private var creating = false
    // people
    @State private var query = ""
    @State private var sharees = Sharees()
    @State private var canEdit = false
    @State private var copied: Int64?

    var body: some View {
        NavigationStack {
            Form {
                let links = (shares ?? []).filter { $0.type == "link" }
                let people = (shares ?? []).filter { $0.type != "link" }
                Section("Links") {
                    ForEach(links) { s in linkRow(s) }
                        .onDelete { remove(links, $0) }
                    if shares != nil && links.isEmpty {
                        Text("No links yet").foregroundStyle(.secondary)
                    }
                }
                Section {
                    PasswordField("Password (optional)", text: $password, contentType: nil)
                    Toggle("Expires", isOn: $expires.animation())
                    if expires {
                        DatePicker("Last day", selection: $expiry, in: Date()..., displayedComponents: .date)
                    }
                    if node.isDir { Toggle("Allow uploads", isOn: $allowUpload) }
                    Button(action: createLink) {
                        if creating { ProgressView() } else { Label("Create link", systemImage: "link.badge.plus") }
                    }
                    .disabled(creating)
                } header: {
                    Text("New link")
                } footer: {
                    Text("Anyone with the link can open it, no account needed.")
                }
                Section("People and groups") {
                    ForEach(people) { s in
                        LabeledContent {
                            Text(s.canEdit == true ? "Can edit" : "Can view").font(.subheadline)
                        } label: {
                            Label(s.shareWith ?? "", systemImage: s.type == "group" ? "person.3.fill" : "person.fill")
                        }
                    }
                    .onDelete { remove(people, $0) }
                    TextField("Add a person or group", text: $query)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Can edit", isOn: $canEdit)
                    ForEach(sharees.users ?? [], id: \.id) { u in
                        Button { shareWith(u.id, group: false) } label: {
                            Label((u.displayName ?? "").isEmpty ? u.id : "\(u.displayName!) (\(u.id))", systemImage: "person.badge.plus")
                        }
                    }
                    ForEach(sharees.groups ?? [], id: \.id) { g in
                        Button { shareWith(g.id, group: true) } label: { Label(g.id, systemImage: "person.3") }
                    }
                }
            }
            .navigationTitle(node.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .animation(.default, value: shares?.map(\.id)) // new links and people slide in, removed ones out
            .animation(.default, value: sharees.users?.map(\.id))
            .sensoryFeedback(.success, trigger: copied) { _, new in new != nil }
            .task { await load() }
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard !q.isEmpty else { sharees = Sharees(); return }
                try? await Task.sleep(nanoseconds: 250_000_000)
                if !Task.isCancelled, let s = try? await API.shared.sharees(q) { sharees = s }
            }
            .errorAlert($error)
        }
    }

    @ViewBuilder
    private func linkRow(_ s: Share) -> some View {
        let url = API.shared.publicURL(s)
        // The address and what applies to it on the left; Copy and Share as two full-size (44 pt) buttons on the right.
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(url?.absoluteString ?? "").font(.callout).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 6) {
                    if s.hasPassword == true { Label("Password", systemImage: "lock.fill").labelStyle(.iconOnly) }
                    if let d = parseDate(s.expiresAt) { Text("Until \(d.formatted(date: .abbreviated, time: .omitted))") }
                    if node.isDir && s.canEdit == true { Text("Uploads allowed") }
                    if copied == s.id { Text("Copied").foregroundStyle(.tint).transition(.opacity) }
                }
                .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.url = url
                withAnimation { copied = s.id }
            } label: {
                Image(systemName: copied == s.id ? "checkmark" : "doc.on.doc")
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel(copied == s.id ? Text("Copied") : Text("Copy"))
            if let url {
                ShareLink(item: url) {
                    Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel(Text("Share"))
            }
        }
        .buttonStyle(.borderless)
        .padding(.trailing, -8) // the glyphs, not their touch areas, line up with the row's edge
    }

    private func load() async {
        do { shares = try await API.shared.shares(node.id) } catch { self.error = errorText(error) }
    }

    private func createLink() {
        creating = true
        Task {
            do {
                let s = try await API.shared.createLink(node.id, password: password, expires: expires ? expiry : nil, canEdit: node.isDir && allowUpload)
                password = ""
                await load()
                if let url = API.shared.publicURL(s) { UIPasteboard.general.url = url; withAnimation { copied = s.id } }
            } catch {
                self.error = errorText(error)
            }
            creating = false
        }
    }

    private func shareWith(_ target: String, group: Bool) {
        Task {
            do {
                try await API.shared.shareWith(node.id, target: target, group: group, canEdit: canEdit)
                query = ""
                await load()
            } catch {
                self.error = errorText(error)
            }
        }
    }

    private func remove(_ list: [Share], _ offsets: IndexSet) {
        let ids = offsets.map { list[$0].id }
        Task {
            do {
                for id in ids { try await API.shared.deleteShare(id) }
            } catch {
                self.error = errorText(error)
            }
            await load()
        }
    }
}
