import Foundation

/// The cloud the reader chose, when it is a cloud. A folder is kept as `FolderLink`, and with
/// neither the notes stay in the container on this device. The account name is not kept here:
/// it stays with the tokens in the keychain (`Tokens.account`).
public struct PlaceRecord: Codable, Equatable {
    public var provider: ProviderID
    /// Set after a switch from another place: older notes wait for "Copy my notes to the new place".
    public var since: Date?

    public init(provider: ProviderID, since: Date? = nil) {
        self.provider = provider
        self.since = since
    }
}

/// A sign-in the extension asked for, that the app finishes when the reader opens it and agrees.
public struct PendingConnect: Codable, Equatable {
    public var provider: ProviderID
    public var at: Date
    /// A random id that the link to the app carries. A link without the id of the request the
    /// extension made is not ours: any app or web page can open the app's address.
    public var request: String?

    public init(provider: ProviderID, at: Date, request: String? = nil) {
        self.provider = provider
        self.at = at
        self.request = request
    }

    /// How long a request waits for the reader.
    public static let lifetime: TimeInterval = 30 * 60

    /// A new request with a fresh random id.
    public static func new(_ p: ProviderID, at: Date = Date()) -> PendingConnect {
        PendingConnect(provider: p, at: at, request: LockCrypto.random(16).map { String(format: "%02x", $0) }.joined())
    }

    /// The cloud a `connect` link asks for, only when it carries the id of this request, for
    /// the same cloud, and the request is recent. Nil for any other link.
    public static func match(_ url: URL, pending: PendingConnect?, now: Date = Date()) -> ProviderID? {
        guard url.host == "connect", let pending, let want = pending.request, !want.isEmpty,
              now.timeIntervalSince(pending.at) >= 0, now.timeIntervalSince(pending.at) < lifetime else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (n: String) in items.first { $0.name == n }?.value }
        guard let p = value("place").flatMap(ProviderID.init(rawValue:)), p == pending.provider,
              let got = value("request"), LockCrypto.same(Data(got.utf8), Data(want.utf8)) else { return nil }
        return p
    }
}

/// One write or removal that could not reach the cloud yet.
public struct QueueEntry: Codable, Equatable {
    public var op: String
    public var at: Date
    /// The version the cloud had when the change was made here. Nil when the file was missing.
    public var base: String?
    public var provider: ProviderID
}

/// How the last cloud sync went, for the app's screen.
public struct CloudSyncState: Codable, Equatable {
    public var at: Date?
    public var problem: String?
    public var pulled = 0
    public var pushed = 0
    public var waiting = 0
}

extension SharedSpace {
    public var place: PlaceRecord? {
        get { load("place.json") }
        set { save(newValue, "place.json") }
    }

    /// Development builds kept the account name in `place.json`, in the App Group files. It
    /// belongs with the tokens in the keychain only, so it is taken out once.
    public func dropStoredAccount() {
        let u = stateDir.appendingPathComponent("place.json")
        guard let d = try? Data(contentsOf: u),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], o["account"] != nil else { return }
        let p = place
        save(p, "place.json")
    }

    public var pendingConnect: PendingConnect? {
        get { load("connect.json") }
        set { save(newValue, "connect.json") }
    }

    public var cloudSync: CloudSyncState? {
        get { load("cloud-sync.json") }
        set { save(newValue, "cloud-sync.json") }
    }

    var queueIndex: [String: QueueEntry] {
        get { load("queue.json") ?? [:] }
        set { save(newValue.isEmpty ? nil : newValue, "queue.json") }
    }

    /// The version of each file last copied from the cloud into the container.
    func pulled(_ p: ProviderID) -> [String: String] { load("pulled-\(p.rawValue).json") ?? [:] }
    func setPulled(_ p: ProviderID, _ v: [String: String]?) { save(v, "pulled-\(p.rawValue).json") }

    public func cloudCache(_ p: ProviderID) -> CacheStore {
        CacheStore(get: { [self] in load("cloud-\(p.rawValue).json") }, set: { [self] in save($0, "cloud-\(p.rawValue).json") })
    }

    public var queueStore: DirectoryStore { DirectoryStore(root: root.appendingPathComponent("Queue", isDirectory: true), coordinated: false) }

    /// Forget everything kept for a cloud: tokens, lists and waiting changes. Notes stay.
    public func forgetCloud(_ p: ProviderID, secrets: SecretStore) {
        secrets.remove(Tokens.key(p))
        cloudCache(p).set(nil)
        setPulled(p, nil)
        let q = queueIndex.filter { $0.value.provider != p }
        for name in queueIndex.keys where q[name] == nil { try? queueStore.remove(name) }
        queueIndex = q
        cloudSync = nil
    }
}

/// Changes that wait in the shared container until the cloud can be reached. The app sends
/// them when it opens or comes to the front, and the extension when it next lists the cloud.
/// A change whose file was changed elsewhere meanwhile is never written over it: it goes up
/// as a sync copy, which the extension merges by record key and removes.
public struct WriteQueue {
    let space: SharedSpace
    public init(space: SharedSpace) { self.space = space }

    public var count: Int { space.queueIndex.count }
    public func names(_ p: ProviderID) -> Set<String> { Set(space.queueIndex.filter { $0.value.provider == p }.keys) }

    public func put(_ name: String, _ data: Data?, base: String?, provider: ProviderID, now: Date = Date()) throws {
        var idx = space.queueIndex
        // A change waiting already keeps its first base: that is what this device last saw.
        let keep = idx[name]?.provider == provider ? idx[name]?.base : base
        if let data { try space.queueStore.write(name, data) } else { try? space.queueStore.remove(name) }
        idx[name] = QueueEntry(op: data == nil ? "remove" : "write", at: now, base: keep, provider: provider)
        space.queueIndex = idx
    }

    /// Writes `data` as a new sync copy of `name`. A copy name already in the cloud, even one
    /// made in the same minute, is never written over: the next free name is used.
    static func writeCopy(of name: String, _ data: Data, date: Date, to folder: CloudFolder) async throws {
        var taken = Set<String>()
        for _ in 0..<20 {
            let copy = Mirror.conflictName(name, date: date, taken: taken)
            taken.insert(copy)
            if folder.peek(copy) != nil { continue }
            do {
                try await folder.write(copy, data, expect: .version(nil))
                return
            } catch let c as CloudError where c.code == .conflict {
                continue
            }
        }
        throw CloudError(.conflict, "no free copy name")
    }

    public func drop(_ name: String) {
        var idx = space.queueIndex
        guard idx[name] != nil else { return }
        idx[name] = nil
        try? space.queueStore.remove(name)
        space.queueIndex = idx
    }

    /// Sends waiting changes, oldest first, until one fails or the time runs out. Returns how
    /// many were sent. Stops at the first problem and keeps the rest.
    @discardableResult
    public func flush(_ p: ProviderID, to folder: CloudFolder, limit: Int = .max, deadline: Date = .distantFuture,
                      now: Date = Date()) async throws -> Int {
        let entries = space.queueIndex.filter { $0.value.provider == p }.sorted { $0.value.at < $1.value.at }
        guard !entries.isEmpty else { return 0 }
        try await folder.refresh()
        var sent = 0
        for (name, e) in entries.prefix(limit) {
            if Date() > deadline { break }
            if e.op == "remove" {
                // Removed here, changed elsewhere: the other device's change stays.
                if folder.peek(name) == e.base, folder.peek(name) != nil {
                    do { try await folder.remove(name) } catch let c as CloudError where c.code == .notFound {}
                }
            } else {
                guard let data = try? space.queueStore.read(name) else {
                    drop(name)
                    continue
                }
                do {
                    try await folder.write(name, data, expect: .version(e.base))
                } catch let c as CloudError where c.code == .conflict {
                    try await Self.writeCopy(of: name, data, date: e.at, to: folder)
                }
            }
            drop(name)
            sent += 1
        }
        return sent
    }
}

/// Everything a cloud needs, made the same way in the app and in the extension's handler.
public struct CloudSetup {
    public let space: SharedSpace
    public let secrets: SecretStore
    public let ids: ClientIds
    public let bundleId: String
    /// The visible folder's name on Google Drive: the product's name.
    public let folderName: String
    public let net: PinnedNet
    public let retry: Retry

    public init(space: SharedSpace, secrets: SecretStore, ids: ClientIds, bundleId: String, folderName: String,
                net: PinnedNet, retry: Retry) {
        self.space = space
        self.secrets = secrets
        self.ids = ids
        self.bundleId = bundleId
        self.folderName = folderName
        self.net = net
        self.retry = retry
        space.dropStoredAccount()
    }

    public var oauth: OAuth { OAuth(ids: ids, bundleId: bundleId, net: net, retry: retry) }

    public func session(_ p: ProviderID) -> TokenSession {
        let o = oauth
        return TokenSession(provider: p, secrets: secrets) { old in try await o.refresh(p, old) }
    }

    public func provider(_ p: ProviderID) -> CloudProvider {
        let t = session(p).source
        switch p {
        case .google: return GoogleDrive(net: net, retry: retry, token: t, folderName: folderName)
        case .onedrive: return OneDrive(net: net, retry: retry, token: t)
        }
    }

    public func folder(_ p: ProviderID) -> CloudFolder {
        CloudFolder(provider: provider(p), cache: space.cloudCache(p))
    }

    public func signedIn(_ p: ProviderID) -> Tokens? { secrets.getJSON(Tokens.key(p)) }

    /// Changes for the cloud in use that have not reached it yet.
    public func waiting() -> Int {
        guard let p = space.place?.provider else { return 0 }
        return WriteQueue(space: space).names(p).count
    }

    /// Keep new tokens and make the cloud the place. The folder, if any, is no longer used.
    /// A switch from another cloud with changes still waiting for it is refused: the switch
    /// would drop them.
    public func connected(_ p: ProviderID, tokens: Tokens) throws {
        let prev = space.place
        if let prev, prev.provider != p, waiting() > 0 { throw CloudError(.conflict, "changes waiting") }
        if let prev, prev.provider != p { space.forgetCloud(prev.provider, secrets: secrets) }
        try secrets.setJSON(Tokens.key(p), tokens)
        space.cloudCache(p).set(nil)
        space.setPulled(p, nil)
        let switching = prev != nil && prev?.provider != p || space.folderLink != nil
        space.place = PlaceRecord(provider: p, since: prev?.provider == p ? prev?.since : (switching ? Date() : nil))
        space.folderLink = nil
        space.mirrorState = MirrorState()
        space.extensionAccess = nil
        space.pendingConnect = nil
    }

    /// Stop using the cloud. With `removeFiles`, its folder goes to the provider's bin first;
    /// if that fails, the sign-in stays so the reader can try again. The notes on this device stay.
    public func disconnect(removeFiles: Bool) async throws {
        guard let p = space.place?.provider else { return }
        if removeFiles { try await folder(p).removeAll() }
        if let t = signedIn(p) { await oauth.revoke(p, t) }
        space.forgetCloud(p, secrets: secrets)
        space.place = nil
    }
}

/// The extension's file requests, sent on to the cloud the reader chose. Every write also goes
/// to the container first, so this device always keeps every note. A write the cloud cannot
/// take now waits in the queue.
public struct CloudRoutes {
    public let kit: CloudSetup
    /// The address that opens the app and asks it to finish a sign-in.
    public let appURL: (ProviderID) -> URL?
    /// Opens that address where the extension may (macOS). Nil on iPadOS.
    public let openApp: ((URL) -> Void)?
    /// The time the handler allows itself for sending waiting changes before a list.
    public var flushSeconds: TimeInterval = 5

    public init(kit: CloudSetup, appURL: @escaping (ProviderID) -> URL?, openApp: ((URL) -> Void)?) {
        self.kit = kit
        self.appURL = appURL
        self.openApp = openApp
    }

    var space: SharedSpace { kit.space }
    var container: DirectoryStore { space.store() }

    /// The cloud in use, when it has tokens.
    public var active: ProviderID? { space.place?.provider }

    public func status() -> [String: Any]? {
        guard let pl = space.place else { return nil }
        var r: [String: Any] = ["ok": true, "folder": pl.provider.name, "place": pl.provider.rawValue]
        // The name comes from the keychain, for the extension to show. The extension keeps it nowhere.
        if let a = kit.signedIn(pl.provider)?.account { r["account"] = a }
        return r
    }

    public func connect(_ p: ProviderID, now: Date = Date()) async -> [String: Any] {
        guard kit.ids.isSetUp(p) else { return fail(.notSetUp) }
        if let t = kit.signedIn(p) {
            if space.place?.provider != p {
                do { try kit.connected(p, tokens: t) } catch { return fail((error as? CloudError)?.code ?? .denied) }
            }
            var r: [String: Any] = ["ok": true]
            if let a = t.account { r["account"] = a }
            return r
        }
        // The extension cannot show a sign-in window. The app does it when the reader opens it
        // and agrees. The link carries this request's id, so the app ignores any other link.
        let pending = PendingConnect.new(p, at: now)
        space.pendingConnect = pending
        var r: [String: Any] = ["ok": true, "pending": true]
        if let base = appURL(p), var c = URLComponents(url: base, resolvingAgainstBaseURL: false) {
            c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "request", value: pending.request)]
            guard let u = c.url else { return r }
            r["open"] = u.absoluteString
            openApp?(u)
        }
        return r
    }

    public func disconnect(removeFiles: Bool) async -> [String: Any] {
        do {
            try await kit.disconnect(removeFiles: removeFiles)
            return ["ok": true]
        } catch {
            return ["ok": false, "error": CloudError.code(of: error)]
        }
    }

    /// list, read, write or remove, for the cloud `p`.
    public func run(_ p: ProviderID, op: String, name: String, dir: String, text: String) async -> [String: Any] {
        guard kit.signedIn(p) != nil else { return fail(.expired) }
        let folder = kit.folder(p)
        let queue = WriteQueue(space: space)
        do {
            switch op {
            case "list":
                if dir == CloudFolder.dir, queue.count > 0 {
                    // Send what waits first, so the listing shows it. Time is short here.
                    _ = try? await queue.flush(p, to: folder, limit: 50, deadline: Date().addingTimeInterval(flushSeconds))
                }
                let files = try await folder.list(dir).map { e -> [String: Any] in
                    ["name": e.name, "mtime": NSNumber(value: e.mtime), "size": NSNumber(value: e.size)]
                }
                return ["ok": true, "files": files]
            case "read":
                let d = try await folder.read(name)
                guard let s = String(data: d, encoding: .utf8) else { return Self.failText("not-utf8") }
                // The container keeps a copy of what this device has seen, for the library.
                if !queue.names(p).contains(name), (try? container.read(name)) != d { try? container.write(name, d) }
                return ["ok": true, "text": s]
            case "write":
                let d = Data(text.utf8)
                try? container.write(name, d)
                do {
                    try await folder.write(name, d)
                    queue.drop(name)
                    return ["ok": true]
                } catch let e as CloudError where e.code != .conflict {
                    try queue.put(name, d, base: folder.peek(name), provider: p)
                    // Waiting for the network is not a failure: the change is safe here.
                    if [.offline, .server, .throttled].contains(e.code) { return ["ok": true, "queued": true] }
                    return fail(e.code)
                }
            default:
                try? container.remove(name)
                do {
                    try await folder.remove(name)
                    queue.drop(name)
                } catch let e as CloudError where e.code == .notFound {
                    queue.drop(name)
                    throw e
                } catch let e as CloudError where [.offline, .server, .throttled].contains(e.code) {
                    try queue.put(name, nil, base: folder.peek(name), provider: p)
                    return ["ok": true, "queued": true]
                }
                return ["ok": true]
            }
        } catch {
            return Self.failText(CloudError.code(of: error))
        }
    }

    func fail(_ c: CloudCode) -> [String: Any] { Self.failText(c.rawValue) }
    static func failText(_ c: String) -> [String: Any] { ["ok": false, "error": c] }
}

/// The app's part of a cloud sync: send what waits, then copy new and changed files from the
/// cloud into the container so the library shows notes from every device, then finish a lock
/// that was being turned on or off.
public struct CloudSync {
    public let kit: CloudSetup
    public init(kit: CloudSetup) { self.kit = kit }

    @discardableResult
    public func run() async -> CloudSyncState {
        var st = kit.space.cloudSync ?? CloudSyncState()
        guard let p = kit.space.place?.provider else { return st }
        let folder = kit.folder(p)
        let queue = WriteQueue(space: kit.space)
        let container = kit.space.store()
        do {
            guard kit.signedIn(p) != nil else { throw CloudError(.expired) }
            st.pushed = try await queue.flush(p, to: folder)
            var seen = kit.space.pulled(p)
            var pulled = 0
            let waiting = queue.names(p)
            let top = try await folder.list("").filter { $0.name == LockFile.name }
            for e in try await folder.list(CloudFolder.dir) + top {
                guard !waiting.contains(e.name), SafeName.isSafe(e.name), let v = folder.peek(e.name), seen[e.name] != v else { continue }
                let d = try await folder.read(e.name)
                if (try? container.read(e.name)) != d {
                    try container.write(e.name, d)
                    pulled += 1
                }
                seen[e.name] = v
            }
            kit.space.setPulled(p, seen)
            try await settleLock(folder)
            st.pulled = pulled
            st.problem = nil
            st.at = Date()
        } catch {
            st.problem = CloudError.code(of: error)
        }
        st.waiting = queue.count
        kit.space.cloudSync = st
        return st
    }

    func settleLock(_ io: PlaceIO) async throws { try await LockSteps.resume(io, secrets: kit.secrets) }

    /// "Copy my notes to the new place": every note in the container goes up. A name the cloud
    /// already has with other text goes up as a sync copy, so nothing there is written over.
    public func copyAll(now: Date = Date()) async throws -> Int {
        guard let p = kit.space.place?.provider else { return 0 }
        let folder = kit.folder(p)
        let container = kit.space.store()
        let remote = Set(try await folder.list(CloudFolder.dir).map(\.name))
        var n = 0
        for e in try container.list(CloudFolder.dir) where !e.placeholder {
            let d = try container.read(e.name)
            if remote.contains(e.name) {
                if try await folder.read(e.name) == d { continue }
                try await WriteQueue.writeCopy(of: e.name, d, date: now, to: folder)
            } else {
                try await folder.write(e.name, d)
            }
            n += 1
        }
        var pl = kit.space.place
        pl?.since = nil
        kit.space.place = pl
        return n
    }
}

extension CloudSetup {
    /// The setup from this bundle's Info.plist: the bundle id base, the product's name and the
    /// client ids. The app and the extension make it the same way, so they share the keychain
    /// items and the container files.
    public static func standard(space: SharedSpace, bundle: Bundle = .main, retry: Retry) -> CloudSetup {
        let name = bundle.object(forInfoDictionaryKey: "InkStoreName") as? String
            ?? bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Notes"
        return CloudSetup(space: space, secrets: KeychainStore.shared(bundle: bundle), ids: ClientIds.load(bundle: bundle),
                          bundleId: appId(bundle), folderName: name, net: PinnedNet(), retry: retry)
    }

    static func appId(_ bundle: Bundle) -> String { bundle.object(forInfoDictionaryKey: "InkAppId") as? String ?? "" }

    /// The address that opens the app on its connect screen and starts the sign-in. The app's
    /// own scheme is its bundle id base (Config/App-*.plist, CFBundleURLTypes).
    public static func appURL(bundle: Bundle = .main) -> (ProviderID) -> URL? {
        let scheme = appId(bundle)
        return { p in scheme.isEmpty ? nil : URL(string: "\(scheme)://connect?place=\(p.rawValue)") }
    }
}
