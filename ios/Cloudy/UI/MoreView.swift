import SwiftUI

struct MoreView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @AppStorage(AppLock.key, store: AppLock.defaults) private var appLock = false
    /// The switch shows "on" while Face ID is being asked for; it only stays on when that worked.
    @State private var turningOnLock = false
    /// Turning the lock on failed and Face ID is switched off for Cloudy in the Settings app.
    @State private var biometryDenied = false
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var deletePassword = ""
    @State private var deleting = false
    @State private var deleteError: String?

    var body: some View {
        NavigationStack {
            List {
                if let user = session.user {
                    Section {
                        HStack(spacing: 14) {
                            ProfilePicture(user: user, size: 52)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.name).font(.title3.weight(.semibold))
                                Text(verbatim: "\(user.id) · \(URL(string: session.server)?.host ?? session.server)")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                        StorageRow(user: user)
                    }
                }
                // Same entries and order as Android's More screen; Recent and Shared with you have their own tabs.
                Section {
                    NavigationLink(value: Route.list(.favorites)) { SettingsLabel("Favorites", icon: "star.fill", color: .settingsOrange) }
                    NavigationLink(value: Route.links) { SettingsLabel("Shared by you", icon: "link", color: .settingsTeal) }
                    NavigationLink(value: Route.trash) { SettingsLabel("Trash", icon: "trash.fill", color: .settingsGray) }
                }
                Section {
                    NavigationLink(value: Route.password) { SettingsLabel("Change password", icon: "key.fill", color: .settingsOrange) }
                    NavigationLink(value: Route.devices) { SettingsLabel("Devices", icon: "iphone", color: .settingsIndigo) }
                    if canUseAppLock {
                        Toggle(isOn: Binding(get: { appLock || turningOnLock }, set: setAppLock)) {
                            SettingsLabel("App lock", icon: "faceid", color: .settingsGreen)
                        }
                        .disabled(turningOnLock)
                        if biometryDenied {
                            Text("Face ID is turned off for Cloudy, so App lock can't use it.")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button("Open Settings") {
                                if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
                            }
                        }
                    }
                } footer: {
                    Text("App lock asks for Face ID, Touch ID or your passcode when you return to Cloudy or share files to it. While it is on, Cloudy is not shown in the Files app.")
                }
                // Help, feedback, rating, the website, the privacy policy and the version all live in About.
                Section {
                    NavigationLink(value: Route.about) { SettingsLabel("About Cloudy", icon: "info", color: .settingsGray) }
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
            // A picture or name changed on the web shows when More opens, as on Android.
            .task { await session.refresh() }
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
                Text("This permanently deletes your account and everything in it: files (including trash and versions), shares and links, and devices. Files downloaded to this iPhone are removed too. It can’t be undone.")
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
    /// Turning the lock on asks for Face ID, Touch ID or the passcode right away. The switch used to be stored without
    /// asking, so the system's "allow Face ID?" question came up later, out of nowhere, on the next return to the app.
    private func setAppLock(_ on: Bool) {
        biometryDenied = false
        guard on else { appLock = false; return }
        guard !turningOnLock else { return }
        turningOnLock = true
        Task {
            let outcome = await AppLock.authenticate(reason: String(localized: "Turn on App lock"))
            if case .ok = outcome {
                appLock = true
            } else {
                biometryDenied = AppLock.biometryDenied
            }
            turningOnLock = false
        }
    }

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
            deleteError = errorText(error) // also explains offline / unreachable / certificate problems
        }
    }
}

/// Settings app tones: fixed, deep and solid in light and dark mode (the dynamic system colors are paler since iOS 26).
/// Orange, green and teal are a shade deeper than Apple's so the white symbol keeps ~3:1 contrast.
extension Color {
    static let settingsBlue = Color(red: 0x00 / 255, green: 0x7A / 255, blue: 0xFF / 255)
    static let settingsOrange = Color(red: 0xF0 / 255, green: 0x82 / 255, blue: 0x00 / 255)
    static let settingsGreen = Color(red: 0x2F / 255, green: 0xA8 / 255, blue: 0x4F / 255)
    static let settingsTeal = Color(red: 0x14 / 255, green: 0x97 / 255, blue: 0xB0 / 255)
    static let settingsGray = Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255)
    static let settingsIndigo = Color(red: 0x58 / 255, green: 0x56 / 255, blue: 0xD6 / 255)
    static let settingsPurple = Color(red: 0xAF / 255, green: 0x52 / 255, blue: 0xDE / 255)
    static let settingsPink = Color(red: 0xFF / 255, green: 0x2D / 255, blue: 0x55 / 255)
}

/// A row label with a white symbol on a colored rounded square, like the Settings app (and growing with the text like there).
private struct SettingsLabel: View {
    let title: LocalizedStringKey
    let icon: String
    let color: Color
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    init(_ title: LocalizedStringKey, icon: String, color: Color) {
        self.title = title
        self.icon = icon
        self.color = color
    }

    var body: some View {
        Label {
            Text(title)
        } icon: {
            let side = 29 * min(scale, 1.5)
            Image(systemName: icon)
                .font(.system(size: side * 0.52, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: side, height: side)
                .background(RoundedRectangle(cornerRadius: side * 0.24, style: .continuous).fill(color))
        }
    }
}

private struct StorageRow: View {
    let user: User

    var body: some View {
        let used = user.used ?? 0
        VStack(alignment: .leading, spacing: 6) {
            if let quota = user.quotaBytes, quota > 0 {
                let part = min(Double(used) / Double(quota), 1)
                ProgressView(value: part).tint(part > 0.9 ? .red : .accentColor).animation(.default, value: part)
                Text("\(formatSize(used)) of \(formatSize(quota)) used").font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("\(formatSize(used)) used").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// More → Change password: the current one, then the new one twice (8+ characters, as on the web). This iPhone stays
/// signed in (its device token isn't the password); the server signs out the browsers signed in to the account.
struct ChangePasswordView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var repeated = ""
    @State private var saving = false
    @State private var currentWrong = false
    @State private var error: String?
    @State private var done = false

    private var tooShort: Bool { !new.isEmpty && new.count < 8 }
    private var mismatch: Bool { !repeated.isEmpty && repeated != new }
    private var canSave: Bool { !current.isEmpty && new.count >= 8 && repeated == new && !saving }

    var body: some View {
        Form {
            // Headers name the fields once they're filled in (the placeholders are gone then).
            Section {
                PasswordField("Current password", text: $current)
            } header: {
                Text("Current password")
            } footer: {
                if currentWrong { Text("Current password is wrong").foregroundStyle(.red) }
            }
            Section {
                PasswordField("New password", text: $new, contentType: .newPassword)
                PasswordField("Repeat new password", text: $repeated, contentType: .newPassword)
            } header: {
                Text("New password")
            } footer: {
                if mismatch { Text("The passwords do not match.").foregroundStyle(.red) }
                else { Text("At least 8 characters").foregroundStyle(tooShort ? .red : .secondary) }
            }
            Section {
                Button { Task { await save() } } label: {
                    HStack { Text("Change password"); if saving { Spacer(); ProgressView() } }
                }
                .disabled(!canSave)
            } footer: {
                Text("Web browsers and your other devices are signed out. This iPhone stays signed in.")
            }
        }
        .disabled(saving)
        .onSubmit { Task { await save() } }
        .onChange(of: current) { currentWrong = false }
        .navigationTitle("Change password")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Password changed", isPresented: $done) {
            Button("OK") { dismiss() }
        }
        .errorAlert($error)
        .sensoryFeedback(.success, trigger: done) { _, isDone in isDone }
        #if DEBUG
        // Simulator testing: CLOUDY_PASSWORD_TEST=[go:]<current>:<new>[:<repeat>] fills in the form; "go:" also submits it.
        .task {
            guard var v = ProcessInfo.processInfo.environment["CLOUDY_PASSWORD_TEST"] else { return }
            let go = v.hasPrefix("go:")
            if go { v.removeFirst(3) }
            let p = v.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            guard p.count >= 2 else { return }
            current = p[0]; new = p[1]; repeated = p.count > 2 ? p[2] : p[1]
            if go { try? await Task.sleep(for: .seconds(1)); await save() }
        }
        #endif
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        defer { saving = false }
        do {
            try await API.shared.changePassword(current: current, password: new)
            current = ""; new = ""; repeated = ""
            done = true
        } catch let e as APIError where e.status == 403 {
            currentWrong = true
        } catch let e as APIError where e.status == 429 {
            self.error = String(localized: "Too many failed attempts, try again later")
        } catch {
            self.error = errorText(error) // also explains offline / unreachable / certificate problems
        }
    }
}

/// Signed-in devices; revoking one signs that device out.
struct DevicesView: View {
    @State private var items: [AppPassword]?
    @State private var loadError: String?
    @State private var error: String?
    @State private var revoking: AppPassword?

    var body: some View {
        List {
            Section {
                ForEach(items ?? []) { p in
                    VStack(alignment: .leading, spacing: 3) {
                        // The badge sits next to the name, or under it when the two don't fit (long names, large text).
                        let badge = Text("This device").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Capsule().fill(Color.accentColor.opacity(0.15))).foregroundStyle(.tint)
                        ViewThatFits(in: .horizontal) {
                            HStack { Text(p.name).lineLimit(1); if p.current == true { badge } }
                            VStack(alignment: .leading, spacing: 3) { Text(p.name); if p.current == true { badge } }
                        }
                        if let d = parseDate(p.lastUsedAt) ?? parseDate(p.createdAt) {
                            Text("Last used \(d.formatted(date: .abbreviated, time: .shortened))").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
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
        .animation(.default, value: items?.map(\.id))
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
