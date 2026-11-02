import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @State private var server = UserDefaults.standard.string(forKey: "server") ?? ""
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
                    VStack(spacing: 10) {
                        Image("Logo")
                            .resizable().frame(width: 72, height: 72)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Text("Cloudy").font(.largeTitle.bold())
                        Text("Sign in to your own Cloudy server: the self-hosted cloud for files, calendars and contacts.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
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
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password).submitLabel(.go)
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
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
                Section {
                    Button(action: signIn) {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Sign in").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || server.isEmpty || user.isEmpty || password.isEmpty)
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

let privacyPolicyURL = URL(string: "https://fahed-alhammadi.github.io/cloudy/privacy-policy.html")!
