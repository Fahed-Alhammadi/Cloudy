import SwiftUI
import AVFoundation
import Photos
import LocalAuthentication

/// First launch: explains what the app needs and lets the user answer each system permission dialog now, so the
/// first sign-in and the first scan or save work right away. Everything can be changed later in iOS Settings.
struct WelcomeView: View {
    var done: () -> Void
    @Environment(\.openURL) private var openURL
    @State private var network: Status = .ask
    @State private var camera: Status = .ask
    @State private var photos: Status = .ask
    @State private var biometrics: Status = .ask
    @State private var asking = false

    enum Status { case ask, granted, denied, unavailable }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(spacing: 10) {
                        Image("Logo")
                            .resizable().frame(width: 72, height: 72)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Text("Welcome to Cloudy").font(.largeTitle.bold())
                        Text("Before you sign in, choose what Cloudy may use on this iPhone. Nothing is required, and you can change each one later in Settings.")
                            .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    row("Local network", "wifi", .blue, network,
                        String(localized: "Needed to reach a server on your home or office network (an address like http://192.168.1.10:8080). Servers on the internet work without it."),
                        askNetwork)
                    row("Camera", "doc.viewfinder", .orange, camera,
                        String(localized: "Scan paper documents and upload them as a PDF."), askCamera)
                    row("Photos", "photo.on.rectangle", .green, photos,
                        String(localized: "Save photos and videos from Cloudy to your photo library."), askPhotos)
                    row("Face ID", "faceid", .teal, biometrics,
                        String(localized: "Lock the app with Face ID, Touch ID or your passcode (App lock in More)."), askBiometrics)
                } footer: {
                    Text("Cloudy connects only to the server you sign in to and collects no data.")
                }
                Section {
                    Button(action: finish) {
                        HStack { Spacer(); Text("Continue").bold(); Spacer() }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .disabled(asking)
            .task { refresh() }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in refresh() }
        }
    }

    private func row(_ title: LocalizedStringKey, _ icon: String, _ color: Color, _ status: Status, _ text: String,
                     _ ask: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(color, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            switch status {
            case .ask:
                Button("Allow", action: ask).buttonStyle(.borderedProminent).controlSize(.small)
            case .granted:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel(Text("Allowed"))
            case .denied:
                Button("Settings") { openSettings() }.buttonStyle(.bordered).controlSize(.small)
            case .unavailable:
                Text("Not available").font(.footnote).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func refresh() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camera = .granted
        case .denied, .restricted: camera = .denied
        default: camera = .ask
        }
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited: photos = .granted
        case .denied, .restricted: photos = .denied
        default: photos = .ask
        }
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
