import SwiftUI
import AVFoundation
import Photos
import LocalAuthentication

/// First launch: explains what the app needs and lets the user answer each system permission dialog now, so the
/// first sign-in and the first scan or save work right away. Everything can be changed later in iOS Settings.
struct WelcomeView: View {
    var done: () -> Void
    @Environment(\.openURL) private var openURL
    @Environment(\.verticalSizeClass) private var heightClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var network: Status = .ask
    // What is already allowed shows as allowed from the first frame (no check mark popping in, no haptic for it).
    @State private var camera = WelcomeView.cameraStatus()
    @State private var photos = WelcomeView.photosStatus()
    @State private var biometrics: Status = .ask
    @State private var asking = false

    enum Status { case ask, granted, denied, unavailable }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    BrandHeader(title: "Welcome to Cloudy",
                                text: "Before you sign in, choose what Cloudy may use on this iPhone. Nothing is required, and you can change each one later in Settings.",
                                compact: heightClass == .compact)
                }
                Section {
                    row("Local network", "wifi", .settingsBlue, network,
                        String(localized: "Needed to reach a server on your home or office network (an address like http://192.168.1.10:8080). Servers on the internet work without it."),
                        askNetwork)
                    row("Camera", "doc.viewfinder", .settingsOrange, camera,
                        String(localized: "Scan paper documents and upload them as a PDF."), askCamera)
                    row("Photos", "photo.on.rectangle", .settingsGreen, photos,
                        String(localized: "Save photos and videos from Cloudy to your photo library."), askPhotos)
                    row("Face ID", "faceid", .settingsTeal, biometrics,
                        String(localized: "Lock the app with Face ID, Touch ID or your passcode (App lock in More)."), askBiometrics)
                } footer: {
                    Text("Cloudy connects only to the server you sign in to and collects no data.")
                }
                // Landscape has no height to spare for a pinned button: there it ends the list.
                if heightClass == .compact {
                    Section { continueButton.listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            // The way forward stays in reach under the list, however long the texts get.
            .safeAreaInset(edge: .bottom) {
                if heightClass != .compact {
                    continueButton.padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 8).background(.bar)
                }
            }
            .disabled(asking)
            .task { refresh() }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in refresh() }
        }
    }

    private var continueButton: some View {
        Button(action: finish) { Text("Continue").fontWeight(.semibold).frame(maxWidth: .infinity) }
            .primaryButton()
    }

    private func row(_ title: LocalizedStringKey, _ icon: String, _ color: Color, _ status: Status, _ text: String,
                     _ ask: @escaping () -> Void) -> some View {
        // The answer sits on the title's line, so the explanation below has the row's whole width; at the
        // accessibility sizes it moves under the text.
        let large = typeSize.isAccessibilitySize
        let answer = Group {
            switch status {
            case .ask:
                Button("Allow", action: ask).buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(.solidAccent)
            case .granted:
                Label("Allowed", systemImage: "checkmark.circle.fill").labelStyle(.iconOnly).font(.title3)
                    .foregroundStyle(Color.settingsGreen).transition(.scale(scale: 0.4).combined(with: .opacity))
            case .denied:
                Button("Settings") { openSettings() }.buttonStyle(.bordered).buttonBorderShape(.capsule)
            case .unavailable:
                Text("Not available").font(.footnote).foregroundStyle(.secondary)
            }
        }
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(color, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title).font(.headline)
                    Spacer(minLength: 0)
                    if !large { answer }
                }
                .frame(minHeight: 36) // level with the icon
                Text(text).font(.subheadline).foregroundStyle(.secondary)
                if large { answer.padding(.top, 4) }
            }
        }
        .padding(.vertical, 4)
        .animation(.snappy(duration: 0.25), value: status)
        .sensoryFeedback(.success, trigger: status) { _, new in new == .granted }
    }

    private static func cameraStatus() -> Status {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .granted
        case .denied, .restricted: .denied
        default: .ask
        }
    }

    private static func photosStatus() -> Status {
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited: .granted
        case .denied, .restricted: .denied
        default: .ask
        }
    }

    private func refresh() {
        camera = Self.cameraStatus()
        photos = Self.photosStatus()
        var err: NSError?
        let ctx = LAContext()
        if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
            if biometrics != .granted { biometrics = .ask }
        } else if let err, err.code == LAError.biometryNotAvailable.rawValue, ctx.biometryType != .none {
            biometrics = .denied // Face ID permission was declined for this app
        } else {
            biometrics = .unavailable
        }
    }

    private func askNetwork() {
        asking = true
        Task {
            switch await LocalNetwork.request() {
            case false: network = .denied
            default: network = .granted // allowed, or no answer (simulator, no network): nothing more to do here
            }
            asking = false
        }
    }

    private func askCamera() {
        asking = true
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async { camera = ok ? .granted : .denied; asking = false }
        }
    }

    private func askPhotos() {
        asking = true
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            DispatchQueue.main.async {
                photos = (status == .authorized || status == .limited) ? .granted : .denied
                asking = false
            }
        }
    }

    private func askBiometrics() {
        asking = true
        let ctx = LAContext()
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: String(localized: "Unlock Cloudy")) { ok, error in
            DispatchQueue.main.async {
                if ok { biometrics = .granted }
                else if let e = error as? LAError, e.code == .biometryNotAvailable { biometrics = .denied }
                else { biometrics = .ask } // cancelled or failed: can try again
                asking = false
            }
        }
    }

    private func openSettings() {
        if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "welcomed")
        done()
    }
}
