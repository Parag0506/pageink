import Foundation
import Observation

/// Where notes are kept, as the Sync screen shows it.
enum PlaceKind: Equatable {
    case device
    case folder(String)
    case cloud(ProviderID)
}

/// The lock as the Sync screen shows it.
enum LockView: Equatable {
    case unknown, off, on, turningOn, turningOff, needsPassword
    /// This device holds the key and the lock file is gone.
    case missing
    /// This device holds the key and the lock file is not the one it knows.
    case changed
}

/// App state. File and network work runs off the main thread; results come back here.
@MainActor
@Observable
final class AppModel {
    nonisolated let space: SharedSpace?
    /// The cloud parts. They make no request until the reader connects a cloud.
    nonisolated let kit: CloudSetup?

    private(set) var pages: [PageSummary] = []
    private(set) var unreadable: [String] = []
    private(set) var lockedFiles: [String] = []
    private(set) var loaded = false

    private(set) var folder: FolderLink?
    private(set) var place: PlaceRecord?
    /// The connected account's name, read from the keychain with the tokens.
    private(set) var account: String?
    private(set) var folderProblem: String?
    private(set) var lastMirror: Date?
    private(set) var lastReport: MirrorReport?
    private(set) var cloudState: CloudSyncState?
    private(set) var extensionAccess: ExtensionAccess?
    private(set) var syncing = false
    private(set) var lock: LockView = .unknown
    /// A provider whose sign-in window is open.
    private(set) var signingIn: ProviderID?
    /// The problem of the last connect, disconnect or lock step: a code from CloudCode.
    var problem: String?
    /// Set when another screen asks for the Sync screen, such as a link from Safari.
    var showSync = false
    /// A cloud the extension asked to connect. Nothing starts until the reader agrees.
    var askConnect: ProviderID?

    /// A short line about the last export or import.
    var notice: String?

    @ObservationIgnored private let window = SignInWindow()

    init(space: SharedSpace? = SharedSpace.appGroup()) {
        self.space = space
        kit = space.map { CloudSetup.standard(space: $0, retry: .app) }
        readState()
    }

    var storageAvailable: Bool { space != nil }

    func isSetUp(_ p: ProviderID) -> Bool { kit?.ids.isSetUp(p) ?? false }

    var placeKind: PlaceKind {
        if let p = place?.provider { return .cloud(p) }
        if let f = folder { return .folder(f.name) }
        return .device
    }

    /// The place's name in a sentence: Google Drive, OneDrive, or the folder in quotes.
    var placeName: String {
        switch placeKind {
        case .cloud(let p): return p.name
        case .folder(let n): return "“\(n)”"
        case .device: return "this device"
        }
    }

    var lastSync: Date? { place != nil ? cloudState?.at : lastMirror }

    private func readState() {
        folder = space?.folderLink
        place = space?.place
        account = place.flatMap { kit?.signedIn($0.provider)?.account }
        lastMirror = space?.mirrorState.lastMirror
        cloudState = space?.cloudSync
        extensionAccess = space?.extensionAccess
    }

    nonisolated private var heldKey: HeldKey? { kit?.secrets.getJSON(HeldKey.secret, HeldKey.self) }

    // MARK: Sync and load

    /// Syncs with the place, then reloads the library. A sign-in the extension asked for is
    /// started here, so the reader only has to open the app.
    func refresh() async {
        guard let space, !syncing else { return }
        if let pending = space.pendingConnect {
            if Date().timeIntervalSince(pending.at) < PendingConnect.lifetime, isSetUp(pending.provider),
               place?.provider != pending.provider {
                // The reader opened the app after Safari asked: ask them first, start nothing.
                showSync = true
                askConnect = pending.provider
            } else {
                space.pendingConnect = nil
            }
        }
        syncing = true
        defer { syncing = false }
        let kit = kit
        let result = await Task.detached(priority: .userInitiated) { await Self.syncAndLoad(space, kit) }.value
        if let report = result.report { lastReport = report }
        folderProblem = result.problem
        pages = result.pages
        unreadable = result.unreadable
        lockedFiles = result.locked
        lock = result.lock
        loaded = true
        readState()
    }

    struct Loaded: Sendable {
        var report: MirrorReport?
        var problem: String?
        var pages: [PageSummary]
        var unreadable: [String]
        var locked: [String]
        var lock: LockView
    }

    nonisolated private static func syncAndLoad(_ space: SharedSpace, _ kit: CloudSetup?) async -> Loaded {
        var report: MirrorReport?
        var problem: String?
        if space.place != nil, let kit {
            await CloudSync(kit: kit).run()
        } else {
            (report, problem) = mirror(space)
            if let kit, let (io, scope) = placeIO(space, kit) {
                _ = try? await keeping(scope) { try await LockSteps.resume(io, secrets: kit.secrets) }
            }
        }
        let lock = await lockState(space, kit)
        let key = kit?.secrets.getJSON(HeldKey.secret, HeldKey.self)?.bytes
        let lib = Library.load(space.store(), key: key)
        return Loaded(report: report, problem: problem, pages: lib.pages, unreadable: lib.errors, locked: lib.locked, lock: lock)
    }

    nonisolated static func mirror(_ space: SharedSpace) -> (MirrorReport?, String?) {
        guard let link = space.folderLink else { return (nil, nil) }
        switch ScopedFolder.open(link.bookmark) {
        case .success(let (scoped, stale)):
            return withExtendedLifetime(scoped) {
                if stale, let fresh = try? scoped.url.bookmarkData(options: ScopedFolder.bookmarkCreateOptions,
                                                                   includingResourceValuesForKeys: nil, relativeTo: nil) {
                    space.folderLink = FolderLink(bookmark: fresh, name: link.name, pickedAt: link.pickedAt)
                }
                var state = space.mirrorState
                let report = Mirror(store: space.store(), folder: DirectoryStore(root: scoped.url, coordinated: true))
                    .run(state: &state)
                space.mirrorState = state
                return (report, nil)
            }
        case .failure:
            return (nil, "The app can no longer open “\(link.name)”. Choose the folder again.")
        }
    }

    // MARK: The place as files

    /// The place's files, for the lock. The folder's scope stays open while `io` lives.
    nonisolated private static func placeIO(_ space: SharedSpace, _ kit: CloudSetup?) -> (PlaceIO, AnyObject?)? {
        if let p = space.place?.provider, let kit { return (kit.folder(p), nil) }
        if let link = space.folderLink {
            guard case .success(let (scoped, _)) = ScopedFolder.open(link.bookmark) else { return nil }
            return (DirectoryIO(DirectoryStore(root: scoped.url, coordinated: true)), scoped)
        }
        return (DirectoryIO(space.store()), nil)
    }

    nonisolated private static func lockState(_ space: SharedSpace, _ kit: CloudSetup?) async -> LockView {
        guard let (io, scope) = placeIO(space, kit) else { return .unknown }
        let read: LockFile.Read
        do {
            read = try await keeping(scope) { try await LockSteps.read(io) }
        } catch {
            return .unknown
        }
        switch LockSteps.judge(read, kit?.secrets.getJSON(HeldKey.secret, HeldKey.self)) {
        case .plain: return .off
        case .needsPassword: return .needsPassword
        case .trouble(let why): return why == "missing" ? .missing : .changed
        case .ready(let l, _): return l.state == "on" ? .on : l.state == "turning-on" ? .turningOn : .turningOff
        }
    }

    /// The place has a lock file, or this device holds a key for one: nothing plain may go there.
    nonisolated private static func lockedPlace(_ space: SharedSpace, _ kit: CloudSetup?) async -> Bool {
        if kit?.secrets.getJSON(HeldKey.secret, HeldKey.self) != nil { return true }
        guard let (io, scope) = placeIO(space, kit) else { return true }
        guard let read = try? await keeping(scope, { try await LockSteps.read(io) }) else { return true }
        if case .none = read { return false }
        return true
    }

    // MARK: Clouds

    /// The reader's answer to a connect the extension asked for.
    func answerConnect(_ yes: Bool) async {
        guard let p = askConnect else { return }
        askConnect = nil
        space?.pendingConnect = nil
        if yes { await connect(p) }
    }

    /// Signs in with the provider's own page and makes the cloud the place.
    func connect(_ p: ProviderID) async {
        guard let kit else { return }
        problem = nil
        // A switch would drop the changes still waiting for the cloud in use.
        if let current = place?.provider, current != p, kit.waiting() > 0 {
            notice = "Some changes have not reached \(current.name) yet. Sync first, then switch."
            return
        }
        guard kit.ids.isSetUp(p) else {
            problem = CloudCode.notSetUp.rawValue
            return
        }
        signingIn = p
        defer { signingIn = nil }
        do {
            let o = kit.oauth
            let start = try o.start(p)
            let back = try await window.open(start.url, scheme: start.redirect.scheme)
            var t = try await o.finish(start, returned: back)
            try kit.secrets.setJSON(Tokens.key(p), t)
            if t.account == nil, let a = await kit.provider(p).account() { t.account = a }
            try kit.connected(p, tokens: t)
            _ = try await kit.folder(p).list(CloudFolder.dir)
        } catch {
            if kit.space.place?.provider != p { kit.secrets.remove(Tokens.key(p)) }
            problem = CloudError.code(of: error)
            readState()
            return
        }
        readState()
        await refresh()
    }

    /// Stops using the place. For a cloud, `removeFiles` first moves its folder to the bin.
    func disconnect(removeFiles: Bool) async {
        guard let kit else { return }
        problem = nil
        if place != nil {
            do {
                try await kit.disconnect(removeFiles: removeFiles)
                kit.secrets.remove(HeldKey.secret)
            } catch {
                problem = CloudError.code(of: error)
            }
        } else {
            stopUsingFolder()
        }
        readState()
        await refresh()
    }

    /// "Copy my notes to the new place".
    func copyAll() async {
        guard let kit, let space else { return }
        if await Task.detached(operation: { await Self.lockedPlace(space, kit) }).value {
            notice = "Your notes there are locked with a password. Use Copy my notes in the browser extension's settings instead."
            return
        }
        do {
            let n = try await CloudSync(kit: kit).copyAll()
            notice = n == 1 ? "Copied 1 page." : "Copied \(n) pages."
        } catch {
            problem = CloudError.code(of: error)
        }
        readState()
        await refresh()
    }

    // MARK: The lock

    /// Turns the lock on: the key is kept first, then the lock file, then each file, so a stop
    /// halfway is finished by the next sync.
    func lockOn(password: String) async -> String? {
        guard let space, let kit else { return "No storage" }
        guard password.count >= 8 else { return "Use at least 8 characters." }
        guard heldKey == nil else { return "Choose below what to do with the lock first." }
        guard let (io, scope) = Self.placeIO(space, kit) else { return "The place cannot be opened." }
        let (l, key) = await Task.detached { LockFile.new(password: password) }.value
        do {
            try await keeping(scope) {
                guard case .none = try await LockSteps.read(io) else { throw CloudError(.locked, "already") }
                var held = HeldKey(key: key.base64EncodedString(), check: l.check, kdf: l.kdf, state: "turning-on")
                try kit.secrets.setJSON(HeldKey.secret, held)
                try await io.write(LockFile.name, l.text)
                _ = try await LockSteps.settle(io, l, key)
                held.state = "on"
                try kit.secrets.setJSON(HeldKey.secret, held)
            }
        } catch {
            return lockError(error)
        }
        await refresh()
        return nil
    }

    /// Turns the lock off on purpose, from this device. Also the way out when the lock file was
    /// removed or changed elsewhere.
    func lockOff() async -> String? {
        guard let space, let kit, var held = heldKey else { return "Enter the password first." }
        guard let (io, scope) = Self.placeIO(space, kit) else { return "The place cannot be opened." }
        do {
            let left = try await keeping(scope) { () -> Int in
                let read = try await LockSteps.read(io)
                var kdf = held.kdf
                if kdf == nil, case .lock(let l) = read, held.fits(l) { kdf = l.kdf }
                held.kdf = kdf
                held.state = "turning-off"
                try kit.secrets.setJSON(HeldKey.secret, held)
                var off = LockFile(kdf: kdf ?? LockFile.KDF(iterations: 0, salt: ""), check: held.check, state: "turning-off")
                if kdf != nil { off = try await LockSteps.write(io, off, key: held.bytes) }
                return try await LockSteps.settle(io, off, held.bytes).skipped.count
            }
            if left > 0 { return "Some files are locked with another password. They were left as they are." }
            kit.secrets.remove(HeldKey.secret)
        } catch {
            return lockError(error)
        }
        await refresh()
        return nil
    }

    /// Puts the lock file back from this device, after it was removed or changed elsewhere.
    func lockRestore() async -> String? {
        guard let space, let kit, var held = heldKey else { return "Enter the password first." }
        guard let kdf = held.kdf else { return "This device does not know the lock's settings. Turn the lock off here instead." }
        guard let (io, scope) = Self.placeIO(space, kit) else { return "The place cannot be opened." }
        do {
            try await keeping(scope) {
                held.state = "turning-on"
                try kit.secrets.setJSON(HeldKey.secret, held)
                let l = try await LockSteps.write(io, LockFile(kdf: kdf, check: held.check, state: "turning-on"), key: held.bytes)
                _ = try await LockSteps.settle(io, l, held.bytes)
                held.state = "on"
                try kit.secrets.setJSON(HeldKey.secret, held)
            }
        } catch {
            return lockError(error)
        }
        await refresh()
        return nil
    }

    /// Opens the lock on this device with the password or the recovery key.
    func unlock(password: String?, code: String?) async -> String? {
        guard let space, let kit else { return "No storage" }
        guard let (io, scope) = Self.placeIO(space, kit) else { return "The place cannot be opened." }
        do {
            let read = try await keeping(scope) { try await LockSteps.read(io) }
            guard case .lock(let l) = read else { return "This lock file cannot be read." }
            let key: Data?
            if let code { key = LockCrypto.fromRecoveryCode(code) } else if let password {
                key = await Task.detached { l.key(password: password) }.value
            } else { key = nil }
            guard let key, var held = l.unlock(key) else { return "That password does not open the lock." }
            if l.v == 2 && !l.verify(key) {
                return "The lock file was changed by someone who does not have the password. Ask whoever can write to that place, or turn the lock on again from a device that has your notes."
            }
            if l.state != "turning-off" { held.state = l.state }
            try kit.secrets.setJSON(HeldKey.secret, held)
        } catch {
            return lockError(error)
        }
        await refresh()
        return nil
    }

    func recoveryCode() -> String? { heldKey.map { LockCrypto.recoveryCode($0.bytes) } }

    private func lockError(_ e: Error) -> String {
        if let c = e as? CloudError, c.code == .locked { return "The lock is already on." }
        let code = CloudError.code(of: e)
        if let p = CloudCode(rawValue: code) { return ProblemText.of(p, placeName).text }
        return "That did not work: \(code)"
    }

    // MARK: Folder

    /// Keeps a folder from the picker. The picker's URL is security scoped. A cloud in use is
    /// disconnected first; its files stay where they are.
    func useFolder(_ url: URL) async {
        guard let space else { return }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            let bookmark = try url.bookmarkData(options: ScopedFolder.bookmarkCreateOptions,
                                                includingResourceValuesForKeys: nil, relativeTo: nil)
            if place != nil, let kit { try? await kit.disconnect(removeFiles: false) }
            kit?.secrets.remove(HeldKey.secret)
            space.folderLink = FolderLink(bookmark: bookmark, name: url.lastPathComponent, pickedAt: Date())
            // A new folder starts a new history: nothing is removed on the first mirror.
            space.mirrorState = MirrorState()
            space.extensionAccess = nil
            folderProblem = nil
        } catch {
            folderProblem = "The app could not keep access to that folder. \(error.localizedDescription)"
            return
        }
        readState()
        await refresh()
    }

    func stopUsingFolder() {
        guard let space else { return }
        space.folderLink = nil
        space.mirrorState = MirrorState()
        space.extensionAccess = nil
        kit?.secrets.remove(HeldKey.secret)
        folderProblem = nil
        lastReport = nil
        readState()
    }

    /// The folder URL with access open, for showing it in Finder or Files.
    func openFolderURL() -> ScopedFolder? {
        guard let link = folder, case .success(let (scoped, _)) = ScopedFolder.open(link.bookmark) else { return nil }
        return scoped
    }

    // MARK: Pages

    /// Sends files the app changed in the container on to the cloud, through the queue, so a
    /// file changed elsewhere meanwhile is never written over.
    nonisolated private static func queueForCloud(_ space: SharedSpace, _ kit: CloudSetup?, _ names: [String]) {
        guard let kit, let p = space.place?.provider else { return }
        let folder = kit.folder(p)
        let queue = WriteQueue(space: space)
        for name in names {
            guard let d = try? space.store().read(name) else { continue }
            try? queue.put(name, d, base: folder.peek(name), provider: p)
        }
    }

    /// Removes every note of a page the merge-safe way, so Safari and other devices drop them too.
    func delete(_ page: PageSummary) async {
        guard let space else { return }
        let files = page.files
        let kit = kit
        let key = heldKey?.bytes
        let errors = await Task.detached(priority: .userInitiated) { () -> [String] in
            let store = space.store()
            var errors: [String] = []
            var done: [String] = []
            for name in files {
                do {
                    let raw = try store.read(name)
                    let env = LockCrypto.envelope(raw)
                    // Never a plain file into a place this device holds a key for, and never
                    // a version 1 file: the next sync in Safari moves those to version 2.
                    if env == nil, key != nil { throw CloudError(.locked) }
                    if let env, env.version != 2 { throw CloudError(.locked) }
                    guard let data = LockSteps.open(raw, key: key, name: name) else { throw CloudError(.locked) }
                    var out = try RecordEditor.removingAllNotes(data)
                    if let env, let f = env.f, let key { out = try LockCrypto.seal(key, name: f, out) }
                    try store.write(name, out)
                    done.append(name)
                } catch {
                    errors.append(name)
                }
            }
            Self.queueForCloud(space, kit, done)
            return errors
        }.value
        if !errors.isEmpty { notice = "Some notes could not be removed." }
        await refresh()
    }

    // MARK: Export and import

    nonisolated func archiveData() throws -> Data {
        guard let space else { throw StoreError.failed("no storage") }
        return try Archive.export(space.store(), key: heldKey?.bytes)
    }

    func markdown() -> String { MarkdownExport.render(pages) }

    func importArchive(from url: URL) async {
        guard let space else { return }
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        let kit = kit
        // An archive holds plain files. They never go into a locked place from here.
        if await Task.detached(operation: { await Self.lockedPlace(space, kit) }).value {
            notice = "Your notes are locked with a password, so the app cannot add plain files to them. Import the archive in the browser extension instead."
            return
        }
        let result = await Task.detached(priority: .userInitiated) { () -> Result<ImportReport, Error> in
            Result {
                let data = try Data(contentsOf: url)
                let r = try Archive.importArchive(data, into: space.store())
                Self.queueForCloud(space, kit, r.written)
                return r
            }
        }.value
        switch result {
        case .success(let r):
            var parts: [String] = []
            if r.added > 0 { parts.append("Added \(r.added) \(r.added == 1 ? "page" : "pages").") }
            if r.copies > 0 { parts.append("\(r.copies) will merge with pages you already have.") }
            if r.same > 0 { parts.append("\(r.same) were already here.") }
            if !r.skipped.isEmpty { parts.append("\(r.skipped.count) files were not notes and were skipped.") }
            notice = parts.isEmpty ? "The archive had no notes." : parts.joined(separator: " ")
        case .failure:
            notice = "That file is not a notes archive."
        }
        await refresh()
    }

    /// A link from Safari: `<scheme>://connect?place=google&request=<id>`. Any app or web page
    /// can open this address, so only a link that carries the id of the request the extension
    /// recorded counts. Even then the app only asks the reader; the sign-in starts on a yes.
    func open(_ url: URL) async {
        guard let p = PendingConnect.match(url, pending: space?.pendingConnect), place?.provider != p else { return }
        showSync = true
        askConnect = p
    }

    static func fileStamp(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}

/// Plain words for each problem, with the one thing to do next. The same words as the
/// extension (src/connect/dest.ts).
enum ProblemText {
    static func of(_ p: CloudCode, _ place: String) -> (text: String, next: String) {
        switch p {
        case .cancelled: return ("The sign-in window was closed before it finished.", "Try again")
        case .denied: return ("\(place) did not give access.", "Try again and choose Allow")
        case .offline: return ("You seem to be offline. Your notes are safe on this device.", "Sync now")
        case .full: return ("Your \(place) storage is full.", "Free up space in \(place), then sync again")
        case .expired: return ("Your sign-in to \(place) has expired.", "Sign in again")
        case .notSetUp: return ("Not set up in this build.", "Choose another place")
        case .locked: return ("Your notes there are locked with a password.", "Enter the password")
        case .throttled: return ("\(place) asked us to slow down.", "Sync again in a minute")
        case .server, .conflict, .reset, .notFound: return ("\(place) had a problem.", "Sync again later")
        }
    }
}

/// Keeps `owner` alive until `body` is done, such as a folder's open security scope.
func keeping<T>(_ owner: AnyObject?, _ body: () async throws -> T) async rethrows -> T {
    defer { withExtendedLifetime(owner) {} }
    return try await body()
}
