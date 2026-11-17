import PhotosUI
import SwiftUI

/// The signed-in user's picture (More) with a camera badge. Tapping it chooses a new picture (the system photo picker:
/// no permission needed), shows it as others will see it, and saves it; with a picture, a menu also offers Remove.
/// Same flow and words as the web's Settings → Profile picture and Android's More screen.
struct ProfilePicture: View {
    let user: User
    var size: CGFloat = 52
    @Environment(Session.self) private var session
    @State private var choosing = false
    @State private var item: PhotosPickerItem?
    @State private var chosen: ChosenPicture?
    @State private var confirmRemove = false
    @State private var error: String?

    var body: some View {
        Group {
            if user.avatar != nil {
                Menu {
                    Button { choosing = true } label: { Label("Change picture", systemImage: "photo.on.rectangle") }
                    Button(role: .destructive) { confirmRemove = true } label: { Label("Remove profile picture", systemImage: "trash") }
                } label: { face }
            } else {
                Button { choosing = true } label: { face }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(user.avatar != nil ? "Change picture" : "Upload picture"))
        .photosPicker(isPresented: $choosing, selection: $item, matching: .images)
        .onChange(of: item) { _, new in
            guard let new else { return }
            item = nil
            Task {
                let data = try? await new.loadTransferable(type: Data.self)
                if let data, let jpeg = await Task.detached(operation: { Avatars.squareJPEG(data) }).value, let img = UIImage(data: jpeg) {
                    chosen = ChosenPicture(jpeg: jpeg, image: img)
                } else {
                    error = String(localized: "This picture can’t be read. Choose another one.")
                }
            }
        }
        .sheet(item: $chosen) { pic in
            PicturePreview(picture: pic) { saved in
                chosen = nil
                if let saved, let me = session.user { session.update(me.with(avatar: saved)) }
            }
        }
        .confirmationDialog("Remove profile picture", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await remove() } }
        } message: {
            Text("Your initials are shown instead.")
        }
        .errorAlert($error)
        #if DEBUG
        // Simulator testing (the photo picker can't be scripted): CLOUDY_PICTURE_TEST=<file> opens the preview with that
        // picture, go:<file> also saves it, remove removes the current one.
        .task {
            guard let v = ProcessInfo.processInfo.environment["CLOUDY_PICTURE_TEST"] else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if v == "remove" { await remove(); return }
            let path = v.hasPrefix("go:") ? String(v.dropFirst(3)) : v
            guard let data = FileManager.default.contents(atPath: path), let jpeg = Avatars.squareJPEG(data), let img = UIImage(data: jpeg) else { return }
            if v.hasPrefix("go:") {
                do { let saved = try await API.shared.setAvatar(jpeg); if let me = session.user { session.update(me.with(avatar: saved)) } }
                catch { self.error = pictureError(error) }
            } else { chosen = ChosenPicture(jpeg: jpeg, image: img) }
        }
        #endif
    }

    private var face: some View {
        Avatar(name: user.name, size: size, userId: user.id, version: user.avatar)
            .overlay(alignment: .bottomTrailing) {
                // The badge says the picture can be changed (controls stay visible, never hidden behind a gesture).
                Image(systemName: "camera.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(Color.solidAccent))
                    .overlay(Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
            .contentShape(Circle())
    }

    private func remove() async {
        do {
            try await API.shared.removeAvatar()
            if let me = session.user { session.update(me.with(avatar: nil)) }
        } catch {
            self.error = pictureError(error)
        }
    }
}

struct ChosenPicture: Identifiable {
    let id = UUID()
    let jpeg: Data
    let image: UIImage
}

/// "New profile picture": the square as others will see it, then Save picture.
private struct PicturePreview: View {
    let picture: ChosenPicture
    /// The new version after a save, nil on Cancel.
    let done: (String?) -> Void
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                // The title sits here: between Cancel and Save picture the bar has no room for it.
                Text("New profile picture").font(.title2.weight(.semibold)).multilineTextAlignment(.center)
                Image(uiImage: picture.image).resizable().scaledToFill()
                    .frame(width: 200, height: 200).clipShape(Circle())
                    .accessibilityLabel(Text("Preview of your new profile picture"))
                Text("This is how other people see you in Cloudy.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { done(nil) }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Save picture") { Task { await save() } }.fontWeight(.semibold) }
                }
            }
            .errorAlert($error)
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(saving)
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do { done(try await API.shared.setAvatar(picture.jpeg)) } catch { self.error = pictureError(error) }
    }
}

/// A failed save or removal as a message; 404 = a server from before profile pictures (1.20).
private func pictureError(_ error: Error) -> String {
    if let e = error as? APIError, e.status == 404 {
        return String(localized: "This server can’t store profile pictures yet. Ask its operator to update Cloudy.")
    }
    return errorText(error)
}

extension User {
    func with(avatar: String?) -> User {
        var u = self
        u.avatar = avatar
        return u
    }
}
