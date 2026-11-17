import SwiftUI

/// "1.19.1 (16)": the version and build of this app.
let appVersion: String = {
    let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    return "\(v) (\(b))"
}()

private let websiteURL = URL(string: "https://fahed-alhammadi.github.io/Cloudy/")!

/// More → About Cloudy. One bold element: the website's night-sky panel with the logo, name and version; below it the
/// links as plain rows, and the copyright line (the same as the README's footer) at the bottom.
struct AboutView: View {
    var body: some View {
        List {
            Section {
                NightSkyHeader()
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.nightSky)
            }
            Section {
                Link(destination: websiteURL) { AboutRow(title: "Website", detail: "fahed-alhammadi.github.io/Cloudy", icon: "globe") }.tint(.primary)
                Link(destination: privacyPolicyURL) { AboutRow(title: "Privacy policy", detail: nil, icon: "hand.raised") }.tint(.primary)
            } footer: {
                VStack(spacing: 4) {
                    Text(verbatim: "© 2026 Fahed Alhammadi. All rights reserved.")
                    Text("Open source under the MIT License.")
                }
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.top, 28)
            }
        }
        .navigationTitle("About Cloudy")
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension Color {
    /// The website's night-sky navy (#062b66) and its sky blue (#4da3ff), the same in light and dark mode.
    static let nightSky = Color(red: 0x06 / 255, green: 0x2B / 255, blue: 0x66 / 255)
    static let skyBlue = Color(red: 0x4D / 255, green: 0xA3 / 255, blue: 0xFF / 255)
}

private struct NightSkyHeader: View {
    /// A few fixed stars (fractions of the panel), so the panel reads as the website's night sky; no animation.
    private let stars: [(x: CGFloat, y: CGFloat, r: CGFloat, o: Double)] = [
        (0.09, 0.18, 1.5, 0.55), (0.22, 0.62, 1, 0.35), (0.31, 0.11, 1, 0.4), (0.72, 0.14, 1.5, 0.5),
        (0.86, 0.44, 1, 0.35), (0.93, 0.12, 1, 0.45), (0.80, 0.78, 1.5, 0.3), (0.14, 0.86, 1, 0.3),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Image("Logo")
                .resizable().frame(width: 84, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous).stroke(.white.opacity(0.18), lineWidth: 1))
                .shadow(color: .black.opacity(0.35), radius: 14, y: 8)
                .accessibilityHidden(true)
            Text(verbatim: "Cloudy")
                .font(.largeTitle.bold()).foregroundStyle(.white)
                .padding(.top, 18)
            Text("The self-hosted cloud for your files.")
                .font(.subheadline).foregroundStyle(.white.opacity(0.78))
                .multilineTextAlignment(.center)
                .padding(.top, 4)
            Text("Version \(appVersion)")
                .font(.footnote.weight(.medium).monospacedDigit())
                .foregroundStyle(Color.skyBlue)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(Capsule().fill(.white.opacity(0.09)))
                .padding(.top, 16)
        }
        .padding(.horizontal, 24)
        .padding(.top, 36).padding(.bottom, 30)
        .frame(maxWidth: .infinity)
        .background {
            GeometryReader { geo in
                ForEach(stars.indices, id: \.self) { i in
                    let s = stars[i]
                    Circle().fill(.white.opacity(s.o)).frame(width: s.r * 2, height: s.r * 2)
                        .position(x: geo.size.width * s.x, y: geo.size.height * s.y)
                }
            }
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A link row: icon in the accent colour, the name, an optional address under it, and the "leaves the app" arrow.
private struct AboutRow: View {
    let title: LocalizedStringKey
    let detail: String?
    let icon: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.body.weight(.medium)).foregroundStyle(Color.accentColor).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let detail { Text(verbatim: detail).font(.footnote).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Image(systemName: "arrow.up.forward").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}
