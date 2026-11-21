import SwiftUI
import UniformTypeIdentifiers

/// Where notes are kept: Google Drive, OneDrive or a folder on this device. The same choices,
/// words and steps as the extension's connect screen.
struct SyncView: View {
    @Environment(AppModel.self) private var model
    @State private var choosing = false
    @State private var picking = false
    @State private var askDisconnect = false
    @State private var askDelete = false

    var body: some View {
        Form {
            if model.placeKind == .device || choosing {
                choices
            } else {
                connected
                if let p = shownProblem,
                   model.place != nil, p != .locked {
                    Section { problemLine(p) }
                }
                if let problem = model.folderProblem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                }
                if model.place?.since != nil {
                    Section {
                        Text("Notes from before the switch are still on this device.")
                        Button("Copy my notes to the new place") { Task { await model.copyAll() } }
                            .accessibilityIdentifier("copy-all")
                    }
                }
                LockSection()
            }
            if let n = model.notice {
                Section { Text(n).foregroundStyle(.secondary) }
            }
            Section("Files") {
                Text("Notes are in a folder named **pages**, one **.ink.json** file per page. They are plain text and stay readable without this app, unless you lock them.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Sync")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result {
                choosing = false
                Task { await model.useFolder(url) }
            }
        }
        .confirmationDialog(disconnectTitle, isPresented: $askDisconnect, titleVisibility: .visible) {
            if model.place != nil {
                Button("Disconnect and keep the files in \(model.placeName)") { Task { await model.disconnect(removeFiles: false) } }
                Button("Disconnect and delete them from \(model.placeName)", role: .destructive) { askDelete = true }
            } else {
                Button("Stop Using Folder", role: .destructive) { Task { await model.disconnect(removeFiles: false) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.place != nil ? "The notes on this device stay. \(Self.revokeLine(model.place?.provider))" : "Notes stay on this device and the files stay in the folder.")
        }
        .alert(askConnectTitle, isPresented: Binding(get: { model.askConnect != nil }, set: { if !$0 { Task { await model.answerConnect(false) } } })) {
            Button("Connect") { Task { await model.answerConnect(true) } }
            Button("Cancel", role: .cancel) { Task { await model.answerConnect(false) } }
        } message: {
            Text("Safari asked to keep your notes in \(model.askConnect?.name ?? "the cloud"). You will sign in on the next screen. If you did not ask for this, choose Cancel.")
        }
        .alert("Delete your notes from \(model.placeName)?", isPresented: $askDelete) {
            Button("Yes, delete them", role: .destructive) { Task { await model.disconnect(removeFiles: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("They go to its bin. The notes on this device stay.")
        }
    }

    private var askConnectTitle: String { "Connect to \(model.askConnect?.name ?? "the cloud")?" }

    /// One plain line on how to take the app's access away in the provider's own account page.
    static func revokeLine(_ p: ProviderID?) -> String {
        switch p {
        case .google: return "To remove the app's access to your Google account too, go to https://myaccount.google.com/connections"
        case .onedrive: return "Microsoft does not let the app give its access back. To remove it, go to https://account.live.com/consent/Manage (work or school account: https://myapps.microsoft.com)"
        case nil: return ""
        }
    }

    private var disconnectTitle: String {
        model.place != nil ? "Stop syncing with \(model.placeName)?" : "Stop using \(model.placeName)?"
    }

    // MARK: The three choices

    @ViewBuilder private var choices: some View {
        Section {
            Text(model.placeKind == .device
                 ? "Your notes are only on this device. Keep a copy in a place you own. \(AppInfo.name) has no server, so nobody else keeps them."
                 : "Now: \(model.placeName). Pick a new place. Nothing is copied or removed by itself.")
                .accessibilityIdentifier("place-state")
            ForEach(ProviderID.allCases, id: \.self) { p in
                let ready = model.isSetUp(p)
                Choice(title: p.name,
                       line: ready ? "Sign in with your \(p.accountKind) account." : "Not set up in this build.",
                       symbol: "icloud", enabled: ready && model.storageAvailable) {
                    choosing = false
                    Task { await model.connect(p) }
                }
                .accessibilityIdentifier("connect-\(p.rawValue)")
            }
            Choice(title: "A folder on this device",
                   line: "Works with iCloud Drive and any folder that syncs.",
                   symbol: "folder", enabled: model.storageAvailable) { picking = true }
                .accessibilityIdentifier("connect")
            if let p = model.signingIn {
                Text("Finish signing in to \(p.name) in the window that opened.").foregroundStyle(.secondary)
            }
            if let p = model.problem.flatMap(CloudCode.init(rawValue:)), model.signingIn == nil {
                problemLine(p, place: "The sign-in")
            }
            if model.placeKind != .device {
                Button("Cancel") { choosing = false }
            }
        } header: {
            Text("Where notes are kept")
        }
    }

    // MARK: Connected

    @ViewBuilder private var connected: some View {
        Section {
            Group {
                if let p = model.place {
                    Text(model.account.map { "Connected to \(p.provider.name) as \($0)." } ?? "Connected to \(p.provider.name).")
                } else {
                    Text("Connected to \(model.placeName).")
                }
            }
            .accessibilityIdentifier("place-state")
            LabeledContent("Last sync") {
                if let t = model.lastSync {
                    Text(t, format: .relative(presentation: .named))
                } else {
                    Text("Not yet")
                }
            }
            if let line = resultLine { LabeledContent("Result", value: line) }
            Button {
                Task { await model.refresh() }
            } label: {
                HStack {
                    Text("Sync Now")
                    if model.syncing {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .disabled(model.syncing)
            .accessibilityIdentifier("sync-now")
            if model.folder != nil && model.place == nil {
                Button("Show Folder") { show() }
            }
            Button("Use another place") { choosing = true }
                .accessibilityIdentifier("change-place")
            Button("Disconnect", role: .destructive) { askDisconnect = true }
                .accessibilityIdentifier("disconnect")
        } header: {
            Text("Where notes are kept")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        if let p = model.place {
            return "Safari sends notes to \(p.provider.name) through this app. When it cannot reach \(p.provider.name), notes wait on this device and go up the next time either can. Only the files this app made are visible to it."
        }
        if model.extensionAccess?.direct == true {
            return "Safari writes to this folder directly. The app also keeps a copy on this device."
        }
        return "Safari writes to storage on this device. The app copies changes to the folder and back each time you open it, and when you tap Sync Now. When a page changed in both places, both copies are kept and merged by the extension."
    }

    private var resultLine: String? {
        if model.place != nil, let s = model.cloudState {
            var parts: [String] = []
            if s.pushed > 0 { parts.append("\(s.pushed) sent") }
            if s.pulled > 0 { parts.append("\(s.pulled) received") }
            if s.waiting > 0 { parts.append("\(s.waiting) waiting to go up") }
            return parts.isEmpty ? (s.problem == nil ? "Up to date" : nil) : parts.joined(separator: ", ")
        }
        guard let r = model.lastReport else { return nil }
        if !r.errors.isEmpty { return "\(r.errors.count) files could not be copied" }
        var parts: [String] = []
        if r.toFolder > 0 { parts.append("\(r.toFolder) to folder") }
        if r.toStore > 0 { parts.append("\(r.toStore) from folder") }
        if r.removed > 0 { parts.append("\(r.removed) removed") }
        if r.conflicts > 0 { parts.append("\(r.conflicts) kept as copies") }
        if r.waiting > 0 { parts.append("\(r.waiting) still downloading") }
        return parts.isEmpty ? "Up to date" : parts.joined(separator: ", ")
    }

    /// One plain line and one next step.
    /// The sign-in problem if there is one, else the problem the last sync reported.
    private var shownProblem: CloudCode? {
        if let raw = model.problem, let code = CloudCode(rawValue: raw) { return code }
        guard let raw = model.cloudState?.problem else { return nil }
        return CloudCode(rawValue: raw)
    }

    @ViewBuilder private func problemLine(_ p: CloudCode, place: String? = nil) -> some View {
        let t = ProblemText.of(p, place ?? model.placeName)
        HStack {
            Label(t.text, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            Spacer()
            switch p {
            case .expired:
                if let pr = model.place?.provider {
                    Button(t.next) { Task { await model.connect(pr) } }
                }
            case .offline, .throttled, .server, .full:
                Button(t.next) { Task { await model.refresh() } }
            case .notSetUp:
                Text(t.next + ".").foregroundStyle(.secondary)
            default:
                Text(t.next + ".").foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("place-problem")
    }

    private func show() {
        guard let scoped = model.openFolderURL() else { return }
        #if os(macOS)
        Platform.showInFinder(scoped.url)
        #else
        Platform.showInFiles(scoped.url)
        #endif
    }
}

/// One large choice: a title and a help line.
private struct Choice: View {
    var title: String
    var line: String
    var symbol: String
    var enabled: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.title2)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(line).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .accessibilityElement(children: .combine)
    }
}

/// "Lock my notes with a password", as in the extension.
private struct LockSection: View {
    @Environment(AppModel.self) private var model
    @State private var turningOn = false
    @State private var confirmOff = false
    @State private var p1 = ""
    @State private var p2 = ""
    @State private var code = ""
    @State private var useCode = false
    @State private var message: String?
    @State private var working = false
    @State private var recovery: String?

    var body: some View {
        Section {
            switch model.lock {
            case .needsPassword:
                Text("Your notes in \(model.placeName) are locked with a password. Enter it once on this device to see and sync them.")
                if useCode {
                    TextField("Recovery key", text: $code)
                        .font(.body.monospaced())
                        .autocorrectionDisabled()
                } else {
                    SecureField("Password", text: $p1)
                }
                Button("Unlock") {
                    run { await model.unlock(password: useCode ? nil : p1, code: useCode ? code : nil) }
                }
                .disabled(working)
                Button(useCode ? "Use the password instead" : "Use a recovery key instead") { useCode.toggle() }
            case .unknown:
                Text("The lock can be set once the place can be reached.").foregroundStyle(.secondary)
            case .missing, .changed:
                Text(model.lock == .missing
                     ? "The lock file in \(model.placeName) is gone, but not because of this device. Syncing has stopped. Your notes are safe here."
                     : "The lock file in \(model.placeName) was changed, but not by this device. Syncing has stopped. Your notes are safe here.")
                    .foregroundStyle(.orange)
                Text("If you did not do this, put the lock back. If you turned the lock off on another device, turn it off here too.")
                Button("Put the lock back from this device") { run { await model.lockRestore() } }
                    .disabled(working)
                Button("Turn the lock off here") { confirmOff = true }
                    .disabled(working)
            default:
                Toggle("Lock my notes with a password", isOn: Binding(
                    get: { isOn || turningOn },
                    set: { on in
                        message = nil
                        if on && !isOn { turningOn = true } else if !on && isOn { confirmOff = true } else { turningOn = false }
                    }))
                    .disabled(working)
                    .accessibilityIdentifier("lock-switch")
                if turningOn && !isOn {
                    Text("If you forget this password, the copy in \(model.placeName) cannot be read by anyone, you included. The notes on each of your devices stay readable. After locking, save a recovery key.")
                        .foregroundStyle(.orange)
                    SecureField("Password", text: $p1)
                    SecureField("Password again", text: $p2)
                    HStack {
                        Button("Lock my notes") {
                            guard p1 == p2 else {
                                message = "The two passwords are not the same."
                                return
                            }
                            run { await model.lockOn(password: p1) }
                        }
                        .disabled(working)
                        Button("Cancel") { turningOn = false }
                    }
                }
                if isOn {
                    Button("Save a recovery key") { recovery = model.recoveryCode() }
                    if let recovery {
                        Text("Your recovery key. Keep it somewhere safe. It opens your notes if you forget the password.")
                        Text(recovery).font(.body.monospaced()).textSelection(.enabled)
                        ShareLink("Print or save it", item: "\(AppInfo.name) recovery key\n\n\(recovery)\n")
                    }
                }
            }
            if working { ProgressView() }
            if let message { Text(message).foregroundStyle(.secondary) }
            if !model.lockedFiles.isEmpty {
                Text("\(model.lockedFiles.count) \(model.lockedFiles.count == 1 ? "file is" : "files are") locked with another password. They are kept as they are.")
                    .foregroundStyle(.orange)
            }
        } header: {
            Text("Password lock")
        } footer: {
            Text(isOn
                 ? "On: your notes are scrambled on this device before they go to \(model.placeName). Only your password opens them."
                 : "Off: \(model.placeName) can read your notes. On: they are scrambled on this device before they leave, so only you can read them.")
        }
        .confirmationDialog("Turn the lock off?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Turn the lock off") { run { await model.lockOff() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(model.placeName) will be able to read your notes again.")
        }
    }

    private var isOn: Bool { [.on, .turningOn, .turningOff].contains(model.lock) }

    private func run(_ step: @escaping () async -> String?) {
        working = true
        message = nil
        Task {
            let r = await step()
            working = false
            message = r
            if r == nil {
                turningOn = false
                p1 = ""
                p2 = ""
                code = ""
            }
        }
    }
}
