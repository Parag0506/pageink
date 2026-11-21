import Foundation

/// Where the extension's file requests go.
public struct NativeTarget {
    public var store: DirectoryStore
    /// Name sent in the `status` reply.
    public var name: String
    /// Keeps a security scope open while requests run.
    var keepAlive: AnyObject?

    public init(store: DirectoryStore, name: String, keepAlive: AnyObject? = nil) {
        self.store = store
        self.name = name
        self.keepAlive = keepAlive
    }
}

/// Answers the extension's folder requests. NATIVE_PROTOCOL.md, version 1.
public struct NativeHandler {
    /// Files are written whole and stay small. This bound keeps one bad message from filling the disk.
    public static let maxTextBytes = 32 * 1024 * 1024

    private let target: () -> NativeTarget?
    private let onAccess: ((Bool) -> Void)?
    private let cloud: CloudRoutes?
    private let forgetFolder: (() -> Void)?

    /// `target` is asked once per request. Nil means there is no store at all.
    /// `onAccess` keeps what the extension says about its access to every website.
    /// `cloud` answers the cloud requests and the file requests while a cloud is the place.
    /// `forgetFolder` stops using the reader's folder, for `disconnect`.
    public init(target: @escaping () -> NativeTarget?, onAccess: ((Bool) -> Void)? = nil,
                cloud: CloudRoutes? = nil, forgetFolder: (() -> Void)? = nil) {
        self.target = target
        self.onAccess = onAccess
        self.cloud = cloud
        self.forgetFolder = forgetFolder
    }

    /// Every request, the cloud ones included. The file requests go to the cloud while one is
    /// the place, and otherwise to `handle`.
    public func handleAsync(_ message: Any?) async -> [String: Any] {
        guard let msg = message as? [String: Any], Self.int(msg["v"]) == 1, let op = msg["op"] as? String else {
            return handle(message)
        }
        switch op {
        case "connect":
            guard let s = msg["place"] as? String, let p = ProviderID(rawValue: s) else { return Self.fail("bad-request") }
            guard let cloud else { return Self.fail(CloudCode.notSetUp.rawValue) }
            return await cloud.connect(p)
        case "disconnect":
            var remove = false
            if let v = msg["removeFiles"] {
                guard let b = v as? NSNumber, CFGetTypeID(b) == CFBooleanGetTypeID() else { return Self.fail("bad-request") }
                remove = b.boolValue
            }
            if let cloud, cloud.active != nil { return await cloud.disconnect(removeFiles: remove) }
            // A folder is forgotten. Files on disk are never removed.
            forgetFolder?()
            return ["ok": true]
        case "status", "list", "read", "write", "remove":
            guard let cloud, let p = cloud.active else { break }
            let a: Args
            switch Self.args(op, msg) {
            case .success(let x): a = x
            case .failure(let f): return f.reply
            }
            if op == "status", let s = cloud.status() { return s }
            return await cloud.run(p, op: op, name: a.name, dir: a.dir, text: a.text)
        default:
            break
        }
        return handle(message)
    }

    struct Args {
        var name = ""
        var dir = ""
        var text = ""
    }

    struct Refusal: Error {
        var reply: [String: Any]
    }

    /// The names and text of a file request, checked before anything is touched, so bad input
    /// gets the same answer in every state.
    static func args(_ op: String, _ msg: [String: Any]) -> Result<Args, Refusal> {
        var a = Args()
        switch op {
        case "list":
            guard let d = msg["dir"] as? String else { return .failure(Refusal(reply: fail("bad-request"))) }
            // "" lists the root. One trailing slash is allowed, a leading one never.
            a.dir = d.count > 1 && d.hasSuffix("/") ? String(d.dropLast()) : d
            if d.hasPrefix("/") || (!a.dir.isEmpty && !SafeName.isSafe(a.dir)) { return .failure(Refusal(reply: fail("bad-name"))) }
        case "read", "remove", "write":
            guard let n = msg["name"] as? String else { return .failure(Refusal(reply: fail("bad-request"))) }
            guard SafeName.isSafe(n) else { return .failure(Refusal(reply: fail("bad-name"))) }
            a.name = n
            if op == "write" {
                guard let t = msg["text"] as? String else { return .failure(Refusal(reply: fail("bad-request"))) }
                guard t.utf8.count <= maxTextBytes else { return .failure(Refusal(reply: fail("too-large"))) }
                a.text = t
            }
        default:
            break
        }
        return .success(a)
    }

    public func handle(_ message: Any?) -> [String: Any] {
        guard let msg = message as? [String: Any] else { return Self.fail("bad-request") }
        guard Self.int(msg["v"]) == 1 else { return Self.fail("unsupported-version") }
        guard let op = msg["op"] as? String else { return Self.fail("bad-request") }

        switch op {
        case "status", "list", "read", "write", "remove":
            break
        case "access":
            // Needs no folder: it only records what Safari allows.
            guard let all = msg["all"] as? NSNumber, CFGetTypeID(all) == CFBooleanGetTypeID() else {
                return Self.fail("bad-request")
            }
            onAccess?(all.boolValue)
            return ["ok": true]
        default:
            return Self.fail("unknown-op")
        }
        let a: Args
        switch Self.args(op, msg) {
        case .success(let x): a = x
        case .failure(let f): return f.reply
        }
        let name = a.name, dir = a.dir, text = a.text

        guard let t = target() else {
            return op == "status" ? ["ok": true, "folder": NSNull()] : Self.fail("no-folder")
        }
        // The security scope must stay open until the file work is done.
        return withExtendedLifetime(t.keepAlive) { run(op, t, name: name, dir: dir, text: text) }
    }

    private func run(_ op: String, _ t: NativeTarget, name: String, dir: String, text: String) -> [String: Any] {
        do {
            switch op {
            case "status":
                return ["ok": true, "folder": t.name, "place": "folder"]
            case "list":
                let files = try t.store.list(dir).map { e -> [String: Any] in
                    ["name": e.name, "mtime": NSNumber(value: e.mtime), "size": NSNumber(value: e.size)]
                }
                return ["ok": true, "files": files]
            case "read":
                let data = try t.store.read(name)
                guard let s = String(data: data, encoding: .utf8) else { return Self.fail("not-utf8") }
                return ["ok": true, "text": s]
            case "write":
                try t.store.write(name, Data(text.utf8))
                return ["ok": true]
            default:
                try t.store.remove(name)
                return ["ok": true]
            }
        } catch let e as StoreError {
            return Self.fail(e.code)
        } catch {
            return Self.fail(error.localizedDescription)
        }
    }

    static func fail(_ code: String) -> [String: Any] { ["ok": false, "error": code] }

    /// Integer value of a JSON number. Booleans are refused even though they bridge to NSNumber.
    static func int(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber else { return nil }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
        let d = n.doubleValue
        return d == d.rounded() ? Int(exactly: d) : nil
    }
}

extension NativeTarget {
    /// The store the extension uses: the reader's folder when this process can open its bookmark,
    /// otherwise the App Group container, which the app mirrors to the folder.
    /// The outcome is recorded so the app can show which way notes travel.
    public static func forExtension(space: SharedSpace?, defaultName: String, now: Date = Date()) -> NativeTarget? {
        guard let space else { return nil }
        let container = NativeTarget(store: space.store(), name: defaultName)
        guard let link = space.folderLink else { return container }
        switch ScopedFolder.open(link.bookmark) {
        case .success(let (folder, _)):
            record(space, ExtensionAccess(direct: true, at: now, detail: "opened"))
            return NativeTarget(store: DirectoryStore(root: folder.url, coordinated: true),
                                name: link.name, keepAlive: folder)
        case .failure(let e):
            let detail: String
            switch e {
            case .unresolved(let m): detail = "bookmark: \(m)"
            case .noAccess: detail = "no access"
            }
            record(space, ExtensionAccess(direct: false, at: now, detail: detail))
            return NativeTarget(store: space.store(), name: link.name)
        }
    }

    /// Writes the access report only when it changes or is old, so requests stay cheap.
    private static func record(_ space: SharedSpace, _ r: ExtensionAccess) {
        if let old = space.extensionAccess, old.direct == r.direct, old.detail == r.detail,
           r.at.timeIntervalSince(old.at) < 3600 { return }
        space.extensionAccess = r
    }
}
