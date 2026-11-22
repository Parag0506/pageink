import SwiftUI

/// Walks through turning the extension on in Safari.
struct SetupView: View {
    var onDone: () -> Void = {}
    @Environment(AppModel.self) private var model
    @State private var state: ExtensionState = .unknown
    /// What the extension last said about every website. Nil until Safari has run it once.
    @State private var websites: Bool?

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Image("Mark")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 56, height: 56)
                        .accessibilityHidden(true)
                    Text("Write on any web page")
                        .font(.title2.weight(.semibold))
                    Text("\(AppInfo.name) adds a pen to Safari. Your ink stays on the page and comes back when you return. Three steps turn it on.")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }

            #if os(macOS)
            macSteps
            #else
            padSteps
            #endif

            Section {
                Button {
                    Platform.openInSafari(AppInfo.testPage)
                } label: {
                    Label("Open a Test Page in Safari", systemImage: "safari")
                }
            } header: {
                Text("Try it")
            } footer: {
                #if os(macOS)
                Text("Hold Option while you drag to draw with the trackpad or mouse, or press Option-Shift-D to switch drawing on. Reload the page and the ink comes back.")
                #else
                Text("Write with Apple Pencil. A finger still scrolls and taps as usual. Reload the page and the ink comes back. If Safari shrinks its bar when you scroll, tap the address at the top to bring back the \(AppInfo.name) button and its **Draw on this page** switch.")
                #endif
            }

            Section {
                Button("Done", action: onDone)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Set Up Safari")
        .task {
            // Safari gives no notice when the reader flips a switch, so look again every few seconds.
            while !Task.isCancelled {
                #if os(macOS)
                state = await Platform.extensionState()
                #endif
                websites = model.space?.siteAccess?.all
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// The live check for "All Websites: Allow". The extension tells the app when Safari runs it.
    @ViewBuilder private var websitesStatus: some View {
        switch websites {
        case .some(true):
            Label("Every website is allowed", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .accessibilityIdentifier("websites-status")
        case .some(false):
            Label("Not yet. Safari still asks on each website.", systemImage: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
                .accessibilityIdentifier("websites-status")
        case .none:
            Label("Not checked yet. Open any web page in Safari, then come back here.", systemImage: "questionmark.circle")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("websites-status")
        }
    }

    private var websitesWhy: Text {
        #if os(macOS)
        let what = "you cannot draw on a page"
        #else
        let what = "your Pencil does not write on a page"
        #endif
        return Text("If this is left on **Ask**, \(what) until you tap the \(AppInfo.name) button in Safari, and nothing says why. **Allow** fixes this. \(AppInfo.name) needs every website so that your notes appear by themselves when you come back to a page. It reads nothing else.")
    }

    #if os(macOS)
    @ViewBuilder private var macSteps: some View {
        Section {
            Step(n: 1, text: "Open Safari and choose **Safari > Settings**, then click **Extensions**.")
            Step(n: 2, text: "Turn on **\(AppInfo.name)**.")
            HStack {
                status
                Spacer()
                Button("Open Safari Settings") { Platform.openSafariSettings() }
            }
        } header: {
            Text("Turn on the extension")
        }
        Section {
            Step(n: 3, text: "With \(AppInfo.name) selected, click **Edit Websites** and set **When visiting other websites** to **Allow**.")
            websitesStatus
        } header: {
            Text("Allow every website")
        } footer: {
            websitesWhy
        }
    }

    @ViewBuilder private var status: some View {
        switch state {
        case .on:
            Label("The extension is on", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .off:
            Label("The extension is off", systemImage: "circle")
                .foregroundStyle(.secondary)
        case .unknown:
            Label("Checking…", systemImage: "questionmark.circle")
                .foregroundStyle(.secondary)
        }
    }
    #else
    @ViewBuilder private var padSteps: some View {
        Section {
            Step(n: 1, text: "Open **Settings**, tap **Apps**, then **Safari**, then **Extensions**.")
            Step(n: 2, text: "Tap **\(AppInfo.name)** and turn on **Allow Extension**.")
            Button("Open Settings") { Platform.openSettings() }
        } header: {
            Text("In Settings")
        } footer: {
            Text("Settings opens on this app's page. Go back to **Apps** to find **Safari**.")
        }
        Section {
            Step(n: 3, text: "Still there, under **Permissions**, tap **All Websites** and choose **Allow**.")
            websitesStatus
        } header: {
            Text("Allow every website")
        } footer: {
            websitesWhy
        }
        Section {
            Step(n: 1, text: "In Safari, tap the page menu button in the address bar, then **Manage Extensions**, and turn on **\(AppInfo.name)**.")
            Step(n: 2, text: "Open the page menu again, tap **\(AppInfo.name)**, then **Always Allow** and **Always Allow on Every Website**.")
        } header: {
            Text("Or from Safari")
        }
    }
    #endif
}

private struct Step: View {
    let n: Int
    let text: LocalizedStringKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(n)")
                .font(.callout.weight(.semibold).monospacedDigit())
                .foregroundStyle(Color("OnAccent"))
                .frame(width: 24, height: 24)
                .background(Circle().fill(.tint))
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }
}
