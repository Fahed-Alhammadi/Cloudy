import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @Environment(\.verticalSizeClass) private var heightClass
    /// The last server (kept in the App Group since the share extension; signing out keeps the address).
    @State private var server = Session.shared.server
    @State private var user = ""
    @State private var password = ""
    @State private var code = ""
    @State private var needsCode = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case server, user, password, code }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    BrandHeader(title: "Cloudy", text: "Sign in to your own Cloudy server: the self-hosted cloud for files, calendars and contacts.",
                                compact: heightClass == .compact)
                }
                Section {
                    TextField("Server address", text: $server, prompt: Text(verbatim: "https://cloud.example.com"))
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .server).submitLabel(.next)
                        .onSubmit { focus = .user }
                    TextField("Username", text: $user)
                        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .user).submitLabel(.next)
                        .onSubmit { focus = .password }
                    PasswordField("Password", text: $password, isFocused: Binding(
                        get: { focus == .password },
                        set: { if $0 { focus = .password } else if focus == .password { focus = nil } }))
                        .submitLabel(.go)
                        .onSubmit(signIn)
                    if needsCode {
                        TextField("Two-factor code", text: $code)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                            .focused($focus, equals: .code)
                    }
                } footer: {
                    Text("Use the address of your server, e.g. https://cloud.example.com. Plain http:// only works on your local network.")
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
                Section {
                    Button(action: signIn) {
                        // The label keeps its place under the spinner, so the button doesn't change size while busy.
                        Text("Sign in").fontWeight(.semibold).opacity(busy ? 0 : 1)
                            .frame(maxWidth: .infinity)
                            .overlay { if busy { ProgressView().tint(.white) } }
                    }
                    .primaryButton()
                    // Busy keeps the button's color under the white spinner (a disabled button turns gray and hid it);
                    // signIn() ignores a second tap anyway.
                    .disabled(server.isEmpty || user.isEmpty || password.isEmpty)
                    .allowsHitTesting(!busy)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    Link("Don't have a server yet?", destination: installURL)
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 4)
                }
                Section {
                    Button("Forgot password?") {
                        if let u = URL(string: normalized(server) + "/#/forgot") { openURL(u) }
                    }
                    .disabled(server.isEmpty)
                    Link("Privacy policy", destination: privacyPolicyURL)
                } footer: {
                    Text("Cloudy doesn't collect any data. Everything stays between this app and the server you sign in to.")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .animation(.default, value: error) // the error row fades in and out instead of jolting the form
            .animation(.default, value: needsCode)
            .sensoryFeedback(trigger: error) { _, new in new == nil ? nil : .error }
            #if DEBUG
            // Screenshots: CLOUDY_LOGIN_TEST=<user>:<password> fills in the form, CLOUDY_SERVER (without a token) the address.
            .task {
                error = Screenshots.loginError
                if let s = ProcessInfo.processInfo.environment["CLOUDY_SERVER"] { server = s }
                guard let v = ProcessInfo.processInfo.environment["CLOUDY_LOGIN_TEST"], let i = v.firstIndex(of: ":") else { return }
                user = String(v[..<i])
                password = String(v[v.index(after: i)...])
            }
            #endif
        }
    }

    private func normalized(_ s: String) -> String {
        var s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.isEmpty && !s.contains("://") { s = "https://" + s }
        return s
    }

    private func signIn() {
        guard !busy, !server.isEmpty, !user.isEmpty, !password.isEmpty else { return }
        let address = normalized(server)
        server = address
        busy = true
        error = nil
        Task {
            do {
                let r = try await retryingConnection {
                    try await API.shared.login(server: address, user: user.trimmingCharacters(in: .whitespaces),
                                               password: password, code: needsCode ? code : nil)
                }
                session.signIn(server: address, token: r.token, user: r.user)
            } catch let e as APIError where e.twoFactor {
                if needsCode { error = e.message }
                needsCode = true
                focus = .code
            } catch {
                self.error = errorText(error)
            }
            busy = false
        }
    }
}

/// Logo, name and one line of text at the top of the sign-in and welcome screens. `compact` (landscape): the logo moves
/// beside the text, so the form below starts on the first screen.
struct BrandHeader: View {
    let title: LocalizedStringKey
    let text: LocalizedStringKey
    var compact = false

    var body: some View {
        let logo = Image("Logo")
            .resizable().frame(width: compact ? 56 : 76, height: compact ? 56 : 76)
            .clipShape(RoundedRectangle(cornerRadius: compact ? 13 : 17, style: .continuous))
            .shadow(color: .black.opacity(0.1), radius: 10, y: 5)
            .accessibilityHidden(true)
        let name = Text(title).font(compact ? .title2.bold() : .largeTitle.bold())
        let line = Text(text).font(.subheadline).foregroundStyle(.secondary)
        Group {
            if compact {
                HStack(spacing: 16) {
                    logo
                    VStack(alignment: .leading, spacing: 4) { name; line }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 10) {
                    logo.padding(.bottom, 4)
                    name.multilineTextAlignment(.center)
                    line.multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))
    }
}

/// Runs `work`, trying again a few times when the connection itself failed: on the very first use the request can
/// fail while iOS is still showing the Local Network permission dialog, and the user's "Allow" arrives seconds later.
func retryingConnection<T>(attempts: Int = 4, _ work: () async throws -> T) async throws -> T {
    var attempt = 0
    while true {
        do { return try await work() } catch let e as URLError {
            attempt += 1
            let transient: [URLError.Code] = [.notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .timedOut, .dnsLookupFailed]
            guard attempt < attempts, transient.contains(e.code) else { throw e }
            try await Task.sleep(for: .seconds(Double(attempt) * 1.5))
        }
    }
}

let privacyPolicyURL = URL(string: "https://fahed-alhammadi.github.io/Cloudy/privacy-policy.html")!
/// How to run a Cloudy server, for people who don't have one yet.
let installURL = URL(string: "https://github.com/Fahed-Alhammadi/Cloudy#install")!
