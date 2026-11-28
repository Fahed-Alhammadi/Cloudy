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
    @State private var saves = 0 // haptic when a save went through
    /// The version the text was read from: sent with Save, so a newer save by someone else is not replaced unseen.
    @State private var etag: String?
    @State private var changedElsewhere = false

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
        // A focus screen: the tab bar steps aside for the text and the keyboard.
        .toolbar(.hidden, for: .tabBar)
        // With unsaved changes Back (and the swipe back) gives way to Cancel, which asks before discarding.
        .navigationBarBackButtonHidden(dirty)
        .toolbar {
            if dirty {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { confirmDiscard = true }
                }
            }
            // Save is the screen's confirming action (drawn prominent since iOS 26); the file's menu is a plain button.
            if saving {
                ToolbarItem(placement: .confirmationAction) { ProgressView() }
            } else if dirty {
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.bold() }
            } else {
                ToolbarItem(placement: .primaryAction) {
                    Menu { actions.menu(for: node) } label: { Label("Actions", systemImage: "ellipsis") }
                }
            }
        }
        .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
        }
        .alert("This file was changed", isPresented: $changedElsewhere) {
            Button("Overwrite", role: .destructive) { save(overwrite: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Someone else saved “\(node.name)” after you opened it. Overwriting replaces their changes; the server keeps their version as an older version.")
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
        .sensoryFeedback(.success, trigger: saves)
    }

    private func load() async {
        guard saved == nil else { return }
        do {
            // Read before the text (the listing this screen came from may be old): if the file changes between the
            // two requests, Save asks; the other order would overwrite that change.
            let current = (try? await API.shared.node(node.id))?.node.etag
            let (t, utf8) = try await API.shared.downloadText(node.id)
            etag = current ?? node.etag
            text = t
            saved = t
            readOnly = !utf8
            loadError = nil
        } catch {
            loadError = errorText(error)
        }
    }

    private func save(overwrite: Bool = false) {
        saving = true
        let content = text
        Task {
            do {
                etag = try await API.shared.saveText(node.id, content, etag: overwrite ? nil : etag).etag
                saved = content
                saves += 1
            } catch let e as APIError where e.status == 412 {
                changedElsewhere = true
            } catch {
                self.error = errorText(error)
            }
            saving = false
        }
    }
}
