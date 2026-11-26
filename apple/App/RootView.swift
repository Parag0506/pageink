import SwiftUI

enum Pane: String, Hashable, CaseIterable, Identifiable {
    case notes, sync, export, setup, about
    var id: String { rawValue }

    var title: String {
        switch self {
        case .notes: return "Notes"
        case .sync: return "Sync"
        case .export: return "Export and Import"
        case .setup: return "Set Up Safari"
        case .about: return "About"
        }
    }

    var symbol: String {
        switch self {
        case .notes: return "pencil.tip"
        case .sync: return "arrow.triangle.2.circlepath"
        case .export: return "square.and.arrow.up.on.square"
        case .setup: return "safari"
        case .about: return "info.circle"
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("setupDone") private var setupDone = false
    @State private var selection: Pane?

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section {
                    ForEach([Pane.notes, .sync, .export]) { s in
                        NavigationLink(value: s) { Label(s.title, systemImage: s.symbol) }
                    }
                }
                Section {
                    ForEach([Pane.setup, .about]) { s in
                        NavigationLink(value: s) { Label(s.title, systemImage: s.symbol) }
                    }
                }
            }
            .navigationTitle(AppInfo.name)
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
            #endif
        } detail: {
            NavigationStack {
                detail(selection ?? .notes)
            }
        }
        .onAppear {
            // "-InkPane sync" on the command line opens a pane directly, for screenshots.
            let asked = UserDefaults.standard.string(forKey: "InkPane").flatMap(Pane.init(rawValue:))
            if selection == nil { selection = asked ?? (setupDone ? .notes : .setup) }
        }
        .onChange(of: model.showSync) { _, show in
            // A link from Safari asked to finish connecting.
            if show {
                selection = .sync
                model.showSync = false
            }
        }
    }

    @ViewBuilder private func detail(_ s: Pane) -> some View {
        switch s {
        case .notes: LibraryView()
        case .sync: SyncView()
        case .export: ExportView()
        case .setup:
            SetupView {
                setupDone = true
                selection = .notes
            }
        case .about: AboutView()
        }
    }
}

struct AboutView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Form {
            Section {
                Image("Wordmark")
                    .resizable()
                    .scaledToFit()
                    .frame(height: 44)
                    .accessibilityLabel(AppInfo.name)
                    .padding(.vertical, 6)
            }
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Nothing leaves the device unless you connect a cloud.")
                            .font(.headline)
                        Text("There is no account with us and no server of ours. \(AppInfo.name) talks to nobody until you connect Google Drive or OneDrive. Then it talks only to that service's sign-in and file addresses. Your notes are kept on this device, and in the one place you choose.")
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "lock.shield")
                        .foregroundStyle(.tint)
                }
                .padding(.vertical, 4)
            } header: {
                Text("Privacy")
            }

            Section("Storage") {
                LabeledContent("Notes", value: model.storageAvailable ? "On this device" : "Not available in this build")
                LabeledContent("Kept in", value: model.placeKind == .device ? "This device only" : model.placeName)
                LabeledContent("Pages with ink", value: "\(model.pages.count)")
            }

            Section {
                LabeledContent("Version", value: AppInfo.version)
                Link("Rate on the App Store", destination: AppInfo.writeReview)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("About")
    }
}
