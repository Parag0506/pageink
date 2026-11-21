import SwiftUI
#if os(iOS)
import BackgroundTasks
#endif

@main
struct InkApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // The brand accent. Set here as well as in the asset catalog, since not every
                // system version applies the catalog's accent to SwiftUI controls by itself.
                .tint(Color("AccentColor"))
                .task { await model.refresh() }
                .onChange(of: phase) { _, now in
                    // The sync runs whenever the app comes to the front.
                    if now == .active { Task { await model.refresh() } }
                    #if os(iOS)
                    if now == .background { Self.scheduleRefresh(model) }
                    #endif
                }
                .onOpenURL { url in Task { await model.open(url) } }
                #if os(macOS)
                .frame(minWidth: 720, minHeight: 480)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    Task { await model.refresh() }
                }
                #endif
        }
        #if os(iOS)
        // iPadOS may wake the app now and then to send notes that wait for the network. It
        // needs no entitlement, only the background mode and the task name in Info.plist.
        .backgroundTask(.appRefresh(Self.refreshTask)) {
            await model.refresh()
        }
        #endif
        #if os(macOS)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Sync Now") { Task { await model.refresh() } }
                    .keyboardShortcut("r")
            }
        }
        #endif
    }

    #if os(iOS)
    /// The task name from Info.plist (BGTaskSchedulerPermittedIdentifiers).
    static let refreshTask = (Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String])?.first ?? "sync"

    /// Asks for a wake-up only while a cloud is the place. The system decides when, if at all.
    @MainActor static func scheduleRefresh(_ model: AppModel) {
        guard model.place != nil else { return }
        let r = BGAppRefreshTaskRequest(identifier: refreshTask)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(r)
    }
    #endif
}
