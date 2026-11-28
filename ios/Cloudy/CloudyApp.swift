import SwiftUI
import LocalAuthentication

@main
struct CloudyApp: App {
    @State private var session = Session.shared

    init() {
        AppLock.migrate() // before any view reads the switch
        FileCache.pruneInBackground()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(Uploads.shared)
        }
    }
}

struct RootView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var phase
    @AppStorage(AppLock.key, store: AppLock.defaults) private var appLock = false
    #if DEBUG
    @State private var locked = AppLock.isOn || Screenshots.lock // screenshots
    #else
    @State private var locked = AppLock.isOn
    #endif

    var body: some View {
        Group {
            if session.waitingForKeychain {
                KeychainWaitView()
            } else if session.isLoggedIn {
                MainView()
            } else {
                LoginView()
            }
        }
        // The lock lives in its own window above everything, including sheets, the share sheet and Quick Look,
        // which are presented above the root view and would otherwise stay visible and usable while "locked".
        .onChange(of: locked, initial: true) { _, l in LockWindow.shared.set(visible: l && session.isLoggedIn, unlock: unlock) }
        .onChange(of: session.isLoggedIn) { _, on in LockWindow.shared.set(visible: locked && on, unlock: unlock) }
        // "Cloudy" in the Files app exists while signed in, except with the app lock on: the Files app would open the
        // same files without Face ID.
        // While the Keychain can't be read nobody knows whether the account is signed in: the location stays as it is
        // (removing it here once threw away the downloaded copies of an account that was still signed in).
        .onChange(of: filesLocation, initial: true) { _, on in if let on { FilesDomain.setAvailable(on) } }
        // Started before the iPhone's first unlock, the app could not read the lock switch either: it looked off.
        // Read it again the moment the sign-in becomes readable, before the files are shown.
        .onChange(of: session.waitingForKeychain) { _, waiting in
            guard !waiting else { return }
            AppLock.migrate()
            if AppLock.isOn && !locked { locked = true; unlock() }
        }
        .onChange(of: phase) { _, p in
            if p == .active { session.retryKeychain() }
            // Lock on leaving the app; the lock screen also hides content in the app switcher.
            // Only prompt when coming back from the background: Face ID itself makes the app inactive.
            if p == .background { wasBackground = true; if appLock { locked = true } }
            if p == .active && wasBackground {
                wasBackground = false
                if locked { unlock() }
            }
        }
        .task { if locked { unlock() } }
        #if DEBUG
        .task { await Screenshots.start() }
        #endif
    }

    @State private var unlocking = false
    @State private var wasBackground = false

    /// Whether "Cloudy" belongs in the Files app; nil = not known yet.
    private var filesLocation: Bool? { session.waitingForKeychain ? nil : session.isLoggedIn && !appLock }

    private func unlock() {
        guard !unlocking else { return }
        #if DEBUG
        if Screenshots.lock { return } // stays locked for the screenshot
        #endif
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { locked = false; return }
        unlocking = true
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: String(localized: "Unlock Cloudy")) { ok, _ in
            DispatchQueue.main.async {
                unlocking = false
                if ok { locked = false }
            }
        }
    }
}

/// A window at alert level that shows `LockView` while the app is locked.
@MainActor
private final class LockWindow {
    static let shared = LockWindow()
    private var window: UIWindow?

    func set(visible: Bool, unlock: @escaping () -> Void) {
        if !visible { window?.isHidden = true; window = nil; return }
        guard window == nil else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        w.rootViewController = UIHostingController(rootView: LockView(unlock: unlock))
        w.isHidden = false
        window = w
    }
}

private struct LockView: View {
    var unlock: () -> Void

    var body: some View {
        // The app's mark and one line in the middle, the button low where the thumb is. Also what the app switcher shows.
        VStack(spacing: 0) {
            Spacer(minLength: 16)
            Image("Logo")
                .resizable().frame(width: 84, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
                .accessibilityHidden(true)
            Text("Cloudy is locked").font(.title2.bold()).padding(.top, 20)
            Text("Unlock with Face ID, Touch ID or your passcode.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.top, 6)
            Spacer(minLength: 16)
            Button(action: unlock) {
                Label("Unlock", systemImage: "lock.open.fill").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .primaryButton()
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
        .frame(maxWidth: 440)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}

/// Shown instead of the sign-in screen while the device token can't be read from the Keychain. That normally ends by
/// itself within a moment; if it doesn't, signing in again is the way out.
private struct KeychainWaitView: View {
    @Environment(Session.self) private var session
    @State private var stuck = false

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
            if stuck {
                Text("Cloudy can't read your sign-in from this iPhone yet.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Sign in again") { session.signOut(revoke: false) }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
        .task {
            var tries = 0
            while session.waitingForKeychain {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                session.retryKeychain()
                tries += 1
                if tries >= 5 { withAnimation { stuck = true } }
            }
        }
    }
}

/// Whether this device can use App lock (Face ID, Touch ID or a passcode is set up).
var canUseAppLock: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
