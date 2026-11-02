import SwiftUI

struct MainView: View {
    @Environment(Session.self) private var session
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
            CalendarView()
                .tabItem { Label("Calendar", systemImage: "calendar") }.tag(1)
            ContactsView()
                .tabItem { Label("Contacts", systemImage: "person.crop.circle") }.tag(2)
            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(3)
        }
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
