import SwiftUI

/// Views and edits a text file; Save uploads the new content (the server keeps the old one as a version).
struct TextFileView: View {
    let node: FileNode
    /// False in a read-only share: the file is shown, not edited (Save would get a 403).
    var canEdit = true
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var saved: String?
    @State private var loadError: String?
    @State private var error: String?
    @State private var saving = false
    @State private var confirmDiscard = false
    /// Not UTF-8 (e.g. an old Windows file): shown read-only, since saving would change every special character.
    @State private var readOnly = false
    @State private var actions = FileActions()

    private var dirty: Bool { saved != nil && text != saved }

    var body: some View {
        Group {
            if saved != nil && (readOnly || !canEdit) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Group {
                            if !canEdit {
                                Label("Shared with you as read-only", systemImage: "lock")
                            } else {
                                Label("This file isn't UTF-8 text, so it can only be viewed here.", systemImage: "lock")
                            }
                        }
                        .font(.footnote).foregroundStyle(.secondary)
                        Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            } else if saved != nil {
                TextEditor(text: $text)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 8)
            } else if let loadError {
                ErrorState(message: loadError) { Task { await load() } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(node.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(dirty)
        .toolbar {
            if dirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { confirmDiscard = true }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else if dirty {
                    Button("Save", action: save).bold()
                } else {
                    Menu { actions.menu(for: node) } label: { Label("Actions", systemImage: "ellipsis.circle") }
                }
            }
        }
        .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
        }
        .interactiveDismissDisabled(dirty)
        .task {
            actions.canModify = { _ in canEdit } // no rename, move or delete in a read-only share either
            await load()
        }
        .fileActions(actions)
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .tour)) { note in
            guard case .type(let s) = note.object as? Screenshots.Step else { return }
            Task { for ch in s { text.append(ch); try? await Task.sleep(nanoseconds: 40_000_000) } }
        }
        #endif
        .errorAlert($error)
    }

    private func load() async {
        guard saved == nil else { return }
        do {
            let (t, utf8) = try await API.shared.downloadText(node.id)
            text = t
            saved = t
            readOnly = !utf8
            loadError = nil
        } catch {
            loadError = errorText(error)
        }
    }

    private func save() {
        saving = true
        let content = text
        Task {
            do {
                try await API.shared.saveText(node.id, content)
                saved = content
            } catch {
                self.error = errorText(error)
            }
            saving = false
        }
    }
}
