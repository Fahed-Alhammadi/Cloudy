import SwiftUI

struct MoreView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @AppStorage("appLock") private var appLock = false
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var deletePassword = ""
    @State private var deleting = false
    @State private var deleteError: String?

    private var version: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return "\(v) (\(b))"
    }

    var body: some View {
        NavigationStack {
            List {
                if let user = session.user {
                    Section {
                        HStack(spacing: 14) {
                            Avatar(name: user.name, size: 52)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name).font(.title3.weight(.semibold))
                                Text(verbatim: "\(user.id) · \(URL(string: session.server)?.host ?? session.server)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        StorageRow(user: user)
                    }
                }
                // Same entries and order as Android's More screen; the Files tab only shows the folders.
                Section {
                    NavigationLink(value: Route.list(.recent)) { SettingsLabel("Recent", icon: "clock.fill", color: .settingsBlue) }
                    NavigationLink(value: Route.list(.favorites)) { SettingsLabel("Favorites", icon: "star.fill", color: .settingsOrange) }
                    NavigationLink(value: Route.list(.shared)) { SettingsLabel("Shared with you", icon: "person.2.fill", color: .settingsGreen) }
                    NavigationLink(value: Route.links) { SettingsLabel("Shared by you", icon: "link", color: .settingsTeal) }
                    NavigationLink(value: Route.trash) { SettingsLabel("Trash", icon: "trash.fill", color: .settingsGray) }
                }
                Section {
                    NavigationLink { DevicesView() } label: { SettingsLabel("Devices", icon: "iphone", color: .settingsIndigo) }
                    if canUseAppLock {
                        Toggle(isOn: $appLock) { SettingsLabel("App lock", icon: "faceid", color: .settingsGreen) }
                    }
                    Button {
                        if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
                    } label: {
                        LabeledContent {
                            Text(Locale.current.localizedString(forLanguageCode: Locale.current.language.languageCode?.identifier ?? "en") ?? "")
                        } label: {
                            SettingsLabel("Language", icon: "globe", color: .settingsBlue)
                        }
                    }
                    .foregroundStyle(.primary)
                } footer: {
                    Text("App lock asks for Face ID, Touch ID or your passcode when you return to Cloudy. The language is set in the Settings app.")
                }
                Section {
                    if let web = URL(string: session.server) {
                        Link(destination: web) { SettingsLabel("Open Cloudy on the web", icon: "safari.fill", color: .settingsBlue).foregroundStyle(.primary) }
                    }
                    Link(destination: privacyPolicyURL) { SettingsLabel("Privacy policy", icon: "hand.raised.fill", color: .settingsPurple).foregroundStyle(.primary) }
                    LabeledContent("Version", value: version)
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                }
                // App Store 5.1.1(v): the account can be deleted in the app. Same wording and flow as the web and Android.
                Section {
                    Button(role: .destructive) { deletePassword = ""; confirmDelete = true } label: {
                        if deleting { HStack { Text("Delete account"); Spacer(); ProgressView() } } else { Text("Delete account") }
                    }
                    .disabled(deleting)
                } footer: {
                    Text("Deletes your account and all your data on this server for good.")
                }
            }
            .navigationTitle("More")
            .withRoutes()
            .refreshable { await session.refresh() }
            .confirmationDialog("Sign out of Cloudy?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { session.signOut() }
            } message: {
                Text("Files downloaded to this iPhone are removed. Your data stays on the server.")
            }
            #if DEBUG
            // Simulator testing: CLOUDY_DELETE_TEST=<password> opens the prompt filled in; go:<password> also submits it.
            .task {
                guard let v = ProcessInfo.processInfo.environment["CLOUDY_DELETE_TEST"] else { return }
                try? await Task.sleep(for: .seconds(1.5))
                if v.hasPrefix("go:") { deletePassword = String(v.dropFirst(3)); await deleteAccount() }
                else { deletePassword = v; confirmDelete = true }
            }
            #endif
            .alert("Delete account?", isPresented: $confirmDelete) {
                SecureField("Password", text: $deletePassword)
                Button("Delete account", role: .destructive) { Task { await deleteAccount() } }
                    .disabled(deletePassword.isEmpty)
                Button("Cancel", role: .cancel) { deletePassword = "" }
            } message: {
                Text("This permanently deletes your account and everything in it: files (including trash and versions), shares and links, calendars, contacts and devices. Files downloaded to this iPhone are removed too. It can’t be undone.")
            }
            .alert("Couldn’t delete your account", isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deleteError ?? "")
            }
        }
    }
}

extension MoreView {
    private func deleteAccount() async {
        let password = deletePassword
        deletePassword = ""
        deleting = true
        defer { deleting = false }
        do {
            try await API.shared.deleteAccount(password: password)
            session.signOut(revoke: false) // the token died with the account
        } catch let e as APIError where e.status == 404 { // servers before 1.12 have no self-service deletion
            deleteError = String(localized: "This server can’t delete accounts yet. Ask its operator to update Cloudy or to delete your account.")
        } catch {
            deleteError = error.localizedDescription
        }
    }
}

/// Settings app tones: fixed, deep and solid in light and dark mode (the dynamic system colors are paler since iOS 26).
/// Orange, green and teal are a shade deeper than Apple's so the white symbol keeps ~3:1 contrast.
private extension Color {
    static let settingsBlue = Color(red: 0x00 / 255, green: 0x7A / 255, blue: 0xFF / 255)
    static let settingsOrange = Color(red: 0xF0 / 255, green: 0x82 / 255, blue: 0x00 / 255)
    static let settingsGreen = Color(red: 0x2F / 255, green: 0xA8 / 255, blue: 0x4F / 255)
    static let settingsTeal = Color(red: 0x14 / 255, green: 0x97 / 255, blue: 0xB0 / 255)
    static let settingsGray = Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255)
    static let settingsIndigo = Color(red: 0x58 / 255, green: 0x56 / 255, blue: 0xD6 / 255)
    static let settingsPurple = Color(red: 0xAF / 255, green: 0x52 / 255, blue: 0xDE / 255)
}

/// A row label with a white symbol on a colored rounded square, like the Settings app.
private struct SettingsLabel: View {
    let title: LocalizedStringKey
    let icon: String
    let color: Color

    init(_ title: LocalizedStringKey, icon: String, color: Color) {
        self.title = title
        self.icon = icon
        self.color = color
    }

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 29, height: 29)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(color))
        }
    }
}

private struct StorageRow: View {
    let user: User

    var body: some View {
        let used = user.used ?? 0
        VStack(alignment: .leading, spacing: 6) {
            if let quota = user.quotaBytes, quota > 0 {
                ProgressView(value: min(Double(used) / Double(quota), 1))
                Text("\(formatSize(used)) of \(formatSize(quota)) used").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("\(formatSize(used)) used").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// Signed-in devices and app passwords; revoking one signs that device out.
struct DevicesView: View {
    @State private var items: [AppPassword]?
    @State private var loadError: String?
    @State private var error: String?
    @State private var revoking: AppPassword?

    var body: some View {
        List {
            Section {
                ForEach(items ?? []) { p in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(p.name)
                            if p.current == true {
                                Text("This device").font(.caption.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Capsule().fill(Color.accentColor.opacity(0.15))).foregroundStyle(.tint)
                            }
                        }
                        if let d = parseDate(p.lastUsedAt) ?? parseDate(p.createdAt) {
                            Text("Last used \(d.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        if p.current != true {
                            Button("Revoke", role: .destructive) { revoking = p }
                        }
                    }
                }
            } footer: {
                Text("Devices and apps signed in to your account. Revoke one to sign it out, for example a lost phone.")
            }
        }
        .overlay {
            if let loadError, items == nil { ErrorState(message: loadError) { Task { await load() } } }
            else if items == nil { ProgressView() }
        }
        .navigationTitle("Devices")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(Text("Sign out \"\(revoking?.name ?? "")\"?"),
                            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                if let p = revoking {
                    attempt($error) {
                        try await API.shared.revokeAppPassword(p.id)
                        await load()
                    }
                }
            }
        }
        .errorAlert($error)
    }

    private func load() async {
        do { items = try await API.shared.appPasswords(); loadError = nil } catch { loadError = errorText(error) }
    }
}
