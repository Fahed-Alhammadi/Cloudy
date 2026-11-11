import SwiftUI
import UniformTypeIdentifiers

// MARK: - Formatting

func formatSize(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) }

func formatDate(_ d: Date?) -> String {
    guard let d else { return "" }
    return Calendar.current.isDateInToday(d) ? d.formatted(date: .omitted, time: .shortened) : d.formatted(date: .abbreviated, time: .omitted)
}

// MARK: - File types

/// Text files open in the built-in editor (the server keeps the old content as a version).
func isText(_ n: FileNode) -> Bool {
    if n.isDir || n.bytes > 2_000_000 { return false }
    let mime = n.mime ?? ""
    if mime.hasPrefix("text/") { return true }
    let exts: Set = ["txt", "md", "markdown", "json", "xml", "yml", "yaml", "csv", "log", "ini", "conf", "cfg", "toml",
                     "sh", "py", "js", "ts", "css", "html", "htm", "swift", "kt", "java", "c", "h", "cpp", "go", "rs", "sql", "env"]
    return exts.contains(n.ext)
}

/// File type colors, the same as the Android app (`TypeColor` in Common.kt).
enum TypeColor {
    static let folder = Color.accentColor
    static let image = adaptive(0x0E9AA7)
    static let video = adaptive(0xE0457B)
    static let audio = adaptive(0x8B5CF6)
    static let pdf = adaptive(0xD93A3A)
    static let archive = adaptive(0xA0782C)
    static let sheet = adaptive(0x1F9D55)
    static let slides = adaptive(0xE8772E)
    static let doc = adaptive(0x3B66D9)
    static let other = adaptive(0x64748B)

    /// Favorite stars: Android's `FavoriteColor` (system yellow is too pale on a white row).
    static let favorite = Color(red: 0xE5 / 255, green: 0xA5 / 255, blue: 0x0A / 255)

    /// `rgb` in light mode, lifted 40 % toward white in dark mode so glyphs keep their contrast (as on Android).
    private static func adaptive(_ rgb: Int) -> Color {
        let r = CGFloat((rgb >> 16) & 0xFF) / 255, g = CGFloat((rgb >> 8) & 0xFF) / 255, b = CGFloat(rgb & 0xFF) / 255
        return Color(UIColor { traits in
            let k: CGFloat = traits.userInterfaceStyle == .dark ? 0.4 : 0
            return UIColor(red: r + (1 - r) * k, green: g + (1 - g) * k, blue: b + (1 - b) * k, alpha: 1)
        })
    }
}

func fileIcon(_ n: FileNode) -> (String, Color) {
    if n.isDir { return ("folder.fill", TypeColor.folder) }
    let mime = n.mime ?? ""
    switch true {
    case mime.hasPrefix("image/"): return ("photo.fill", TypeColor.image)
    case mime.hasPrefix("video/"): return ("film.fill", TypeColor.video)
    case mime.hasPrefix("audio/"): return ("music.note", TypeColor.audio)
    case mime == "application/pdf" || n.ext == "pdf": return ("doc.richtext.fill", TypeColor.pdf)
    case ["zip", "gz", "tgz", "7z", "rar", "tar"].contains(n.ext): return ("archivebox.fill", TypeColor.archive)
    case ["xls", "xlsx", "ods", "csv", "numbers"].contains(n.ext): return ("tablecells.fill", TypeColor.sheet)
    case ["ppt", "pptx", "odp", "key"].contains(n.ext): return ("play.rectangle.fill", TypeColor.slides)
    case ["doc", "docx", "odt", "rtf", "pages"].contains(n.ext): return ("doc.text.fill", TypeColor.doc)
    case isText(n): return ("doc.plaintext.fill", TypeColor.other)
    default: return ("doc.fill", TypeColor.other)
    }
}

/// The file's type as a tinted rounded square (list rows). The tint is 12 % in light mode and 22 % in dark mode, as on
/// Android: a 12 % tile nearly vanishes on a dark row. Grows with Dynamic Type (up to 1.4×) so it keeps up with the text.
struct TypeTile: View {
    let node: FileNode
    var size: CGFloat = 38
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let (icon, color) = fileIcon(node)
        let side = size * min(scale, 1.4)
        RoundedRectangle(cornerRadius: side * 0.27, style: .continuous)
            .fill(color.opacity(scheme == .dark ? 0.22 : 0.12))
            .frame(width: side, height: side)
            .overlay { Image(systemName: icon).font(.system(size: side * 0.46, weight: .semibold)).foregroundStyle(color) }
            // VoiceOver: a folder is announced as one; for files the name (with its extension) says enough.
            .accessibilityLabel(Text("Folder"))
            .accessibilityHidden(!node.isDir)
    }
}

struct NodeRow: View {
    let node: FileNode
    var subtitle: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 12) {
            TypeTile(node: node)
            VStack(alignment: .leading, spacing: 2) {
                Text(node.name).lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
                Text(subtitle ?? defaultSubtitle).font(.footnote).foregroundStyle(.secondary)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            }
            Spacer(minLength: 0)
            if node.isFavorite {
                Image(systemName: "star.fill").font(.caption).foregroundStyle(TypeColor.favorite)
                    .transition(.scale(scale: 0.2).combined(with: .opacity)) // pops in when the file becomes a favorite
                    .accessibilityLabel(Text("Favorites"))
            }
            if node.shared == true { Image(systemName: "person.2.fill").font(.caption).foregroundStyle(.secondary) }
        }
        .contentShape(Rectangle())
        .animation(.spring(duration: 0.35, bounce: 0.45), value: node.isFavorite)
    }

    private var defaultSubtitle: String {
        let date = formatDate(node.modified)
        return node.isDir ? date : [date, formatSize(node.bytes)].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

// MARK: - Shared looks

extension Color {
    /// Fill for solid shapes that carry white text or glyphs (the "+" button, prominent buttons, the selected day).
    /// The accent color turns light in dark mode, where white on it drops to 2.7:1; this stays deep enough for 4.5:1.
    static let solidAccent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0x18 / 255, green: 0x77 / 255, blue: 0xDD / 255, alpha: 1)
                                           : UIColor(red: 0x0B / 255, green: 0x6B / 255, blue: 0xCB / 255, alpha: 1)
    })
}

extension View {
    /// The grouped gray behind a list, also while it has no rows (an empty list paints the plain background otherwise,
    /// so empty folders and an empty trash turned white).
    func groupedBackground() -> some View {
        scrollContentBackground(.hidden).background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    /// The app's main button: full width, large (50 pt), filled.
    func primaryButton() -> some View {
        buttonStyle(.borderedProminent).controlSize(.large).tint(.solidAccent)
    }
}

// MARK: - Avatars

private let avatarColors: [Color] = [.accentColor, TypeColor.image, TypeColor.sheet, TypeColor.slides, TypeColor.video,
                                     TypeColor.audio, TypeColor.pdf, TypeColor.doc]

/// A stable color per name, the same one the Android app picks (Java's String.hashCode, floor-mod).
func avatarColor(_ name: String) -> Color {
    var h: Int32 = 0
    for unit in name.utf16 { h = h &* 31 &+ Int32(unit) }
    let n = Int32(avatarColors.count)
    return avatarColors[Int(((h % n) + n) % n)]
}

/// Initials in a circle tinted with the name's color (16 % in light mode, 30 % in dark mode, as on Android).
/// Grows with Dynamic Type like `TypeTile`.
struct Avatar: View {
    let name: String
    var size: CGFloat = 40
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        let color = avatarColor(name)
        let side = size * min(scale, 1.4)
        Text(letters.isEmpty ? "?" : letters)
            .font(.system(size: side * 0.38, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: side, height: side)
            .background(Circle().fill(color.opacity(scheme == .dark ? 0.3 : 0.16)))
            .accessibilityHidden(true)
    }
}

// MARK: - Errors and prompts

extension View {
    /// Shows `error` in an alert and clears it on dismiss.
    func errorAlert(_ error: Binding<String?>) -> some View {
        alert("Something went wrong", isPresented: Binding(get: { error.wrappedValue != nil }, set: { if !$0 { error.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error.wrappedValue ?? "")
        }
        .sensoryFeedback(trigger: error.wrappedValue) { _, new in new == nil ? nil : .error }
    }

    /// A one-field alert (new folder, rename…). `onSave` gets the trimmed text.
    func textPrompt(_ title: LocalizedStringKey, isPresented: Binding<Bool>, text: Binding<String>, action: LocalizedStringKey,
                    onSave: @escaping (String) -> Void) -> some View {
        alert(title, isPresented: isPresented) {
            TextField("Name", text: text).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button(action) {
                let t = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { onSave(t) }
            }
        }
    }
}

// MARK: - Password fields

/// A password field with an eye button that shows or hides what was typed (same as the Android app).
/// `isFocused` mirrors the field's focus, so a screen's own `@FocusState` can move focus into it; focus stays in the
/// field when the eye is tapped. `.submitLabel` / `.onSubmit` on the view reach the field as usual.
struct PasswordField: View {
    private let title: LocalizedStringKey
    @Binding private var text: String
    private let isFocused: Binding<Bool>?
    private let contentType: UITextContentType?
    @State private var visible = PasswordField.startVisible
    @FocusState private var focused: Bool

    /// `contentType: nil` for passwords that aren't the account's (share links), so AutoFill doesn't offer it.
    init(_ title: LocalizedStringKey, text: Binding<String>, isFocused: Binding<Bool>? = nil, contentType: UITextContentType? = .password) {
        self.title = title
        self.contentType = contentType
        self._text = text
        self.isFocused = isFocused
    }

    var body: some View {
        HStack(spacing: 4) {
            Group {
                if visible { TextField(title, text: $text) } else { SecureField(title, text: $text) }
            }
            .textContentType(contentType)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .focused($focused)
            Button {
                let refocus = focused
                visible.toggle()
                // The field is a new view now; give it the keyboard back.
                if refocus { Task { @MainActor in focused = true } }
            } label: {
                Image(systemName: visible ? "eye.slash" : "eye")
                    .foregroundStyle(Color.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .padding(.vertical, -8) // 44 pt tap target without making the row taller
            .padding(.trailing, -10)
            .accessibilityLabel(visible ? Text("Hide password") : Text("Show password"))
        }
        .onChange(of: isFocused?.wrappedValue ?? false, initial: true) { _, v in if v != focused { focused = v } }
        .onChange(of: focused) { _, v in if let b = isFocused, b.wrappedValue != v { b.wrappedValue = v } }
    }

    #if DEBUG
    private static let startVisible = ProcessInfo.processInfo.environment["CLOUDY_PASSWORD_VISIBLE"] != nil // screenshots
    #else
    private static let startVisible = false
    #endif
}

/// Runs an API call, putting any error into `error`.
@MainActor
func attempt(_ message: Binding<String?>, _ work: @escaping () async throws -> Void) {
    Task {
        do { try await work() } catch is CancellationError {} catch { message.wrappedValue = errorText(error) }
    }
}

struct ErrorState: View {
    let message: String
    var retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Can't load", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Try again", action: retry)
        }
    }
}

// MARK: - Live updates

extension View {
    /// Calls `action` when the server reports a change in one of `folders` (or in "shared with me" if `shares`),
    /// and after the live-update stream reconnected (changes may have been missed meanwhile).
    func onLiveChange(folders: Set<Int64> = [], shares: Bool = false, any: Bool = false, _ action: @escaping () -> Void) -> some View {
        onReceive(NotificationCenter.default.publisher(for: .cloudyChange)) { note in
            guard let ev = note.object as? ChangeEvent else { return }
            if any || (shares && ev.shares == true) || !(folders.isDisjoint(with: ev.folders ?? [])) { action() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .cloudyResync)) { _ in action() }
    }
}

// MARK: - Sharing files with other apps

/// A file or text that can be handed to the share sheet.
struct ShareItem: Identifiable {
    let id = UUID()
    let items: [Any]
}

struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
