import SwiftUI

struct MainView: View {
    @Environment(Session.self) private var session
    @Environment(Uploads.self) private var uploads
    @Environment(\.scenePhase) private var phase
    #if DEBUG
    @State private var tab = Int(ProcessInfo.processInfo.environment["CLOUDY_TAB"] ?? "") ?? 0 // screenshots
    #else
    @State private var tab = 0
    #endif

    var body: some View {
        TabView(selection: $tab) {
            FilesTab()
                .tabItem { Label("Files", systemImage: "folder") }.tag(0)
            // Same tabs as Android's bottom bar; Recent and Shared are not listed again under More.
            ListTab(kind: .recent)
                .tabItem { Label("Recent", systemImage: "clock") }.tag(1)
            ListTab(kind: .shared)
                .tabItem { Label("Shared", systemImage: "person.2") }.tag(2)
            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(3)
        }
        .sensoryFeedback(.success, trigger: uploads.finished)
        // One live-update stream while the app is active; restarts when it comes back.
        .task(id: phase == .active) {
            guard phase == .active else { return }
            await session.refresh()
            await Live.run()
        }
        #if DEBUG
        .task { Screenshots.shareTest(); await Screenshots.runTour() }
        .onReceive(NotificationCenter.default.publisher(for: .tour)) { note in
            if case .tab(let t) = note.object as? Screenshots.Step { withAnimation { tab = t } }
        }
        #endif
    }
}

/// Recent or Shared with you as a tab: the list is the root of its own stack (no back button).
private struct ListTab: View {
    let kind: ListKind

    var body: some View {
        NavigationStack {
            NodeListView(kind: kind).withRoutes()
        }
    }
}
