import Foundation

/// A place the notes are kept, seen as files by name: the container, a folder, or a cloud.
/// Names are relative, such as "pages/abc.ink.json" or "pageink.lock.json".
public protocol PlaceIO: AnyObject {
    func list(_ dir: String) async throws -> [FileEntry]
    func read(_ name: String) async throws -> Data
    func write(_ name: String, _ data: Data) async throws
    /// Throws not-found when there is no such file.
    func remove(_ name: String) async throws
}

/// A folder on disk as a place.
public final class DirectoryIO: PlaceIO {
    public let store: DirectoryStore
    public init(_ store: DirectoryStore) { self.store = store }
    public func list(_ dir: String) async throws -> [FileEntry] { try store.list(dir) }
    public func read(_ name: String) async throws -> Data { try store.read(name) }
    public func write(_ name: String, _ data: Data) async throws { try store.write(name, data) }
    public func remove(_ name: String) async throws { try store.remove(name) }
}

/// What a cloud folder remembers between runs, in the shared container's State folder. It
/// holds file ids, names, times and versions: no tokens and no note text.
public struct CloudCache: Codable, Equatable {
    public var folders: Folders?
    public var files: [RemoteFile] = []
    public var cursor: String?
    /// When the last full listing was made, epoch ms.
    public var listedAt: Int64 = 0
    /// When the list was last brought up to date, epoch ms.
    public var checkedAt: Int64 = 0
    public var top: [RemoteFile]?
    public var topAt: Int64 = 0

    public init() {}
}

public struct CacheStore {
    public var get: () -> CloudCache?
    public var set: (CloudCache?) -> Void

    public init(get: @escaping () -> CloudCache?, set: @escaping (CloudCache?) -> Void) {
        self.get = get
        self.set = set
    }

    public static func memory() -> CacheStore {
        final class Box { var v: CloudCache? }
        let b = Box()
        return CacheStore(get: { b.v }, set: { b.v = $0 })
    }
}

/// A cloud seen as a folder, as src/cloud/folder.ts: names map to file ids through a list that
/// is kept between runs and rebuilt by listing, in full now and then and otherwise with the
/// provider's change check. Same layout as the folder: pages/<hash>.ink.json and the lock file
/// on top. The extension's handler runs in a new process now and then, so the list is read
/// from the cache each time and trusted for a short while.
public final class CloudFolder: PlaceIO {
    public static let dir = "pages"
    /// A full listing at least this often. Between them the change check is enough.
    public static let relistMs: Int64 = 60 * 60 * 1000
    /// How long a list is trusted for a read or a write without asking again.
    public static let trustMs: Int64 = 60 * 1000

    let provider: CloudProvider
    let cache: CacheStore
    let now: () -> Int64
    private var state: CloudCache

    public init(provider: CloudProvider, cache: CacheStore, now: @escaping () -> Int64 = nowMillis) {
        self.provider = provider
        self.cache = cache
        self.now = now
        state = cache.get() ?? CloudCache()
    }

    private func save() { cache.set(state) }

    func ensure() async throws -> Folders {
        if let f = state.folders { return f }
        let f = try await provider.folders()
        state.folders = f
        save()
        return f
    }

    private func fullList() async throws {
        var f = try await ensure()
        let l: Listing
        do {
            l = try await provider.list(f.pages)
        } catch let e as CloudError where e.code == .notFound {
            // The folder went away (the reader removed it). Find or make it again.
            state = CloudCache()
            f = try await ensure()
            l = try await provider.list(f.pages)
        }
        state.files = l.files
        state.cursor = l.cursor
        state.listedAt = now()
        state.checkedAt = now()
        save()
    }

    /// Bring the list up to date: in full when old, otherwise with the change check.
    public func refresh() async throws {
        let f = try await ensure()
        guard let cursor = state.cursor, now() - state.listedAt <= Self.relistMs else { return try await fullList() }
        do {
            let c = try await provider.changes(f.pages, cursor)
            var byId = Dictionary(state.files.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for id in c.gone { byId[id] = nil }
            for x in c.files { byId[x.id] = x }
            state.files = Array(byId.values)
            state.cursor = c.cursor
            state.checkedAt = now()
            save()
        } catch let e as CloudError where e.code == .reset || e.code == .notFound {
            try await fullList()
        }
    }

    /// Two files with one name can happen on Drive. The one with the lowest id keeps the name,
    /// so every device picks the same one. Each other one is shown as a sync copy,
    /// "<stem> (copy <id>).ink.json", which the extension folds in and removes.
    static func named(_ files: [RemoteFile]) -> [String: RemoteFile] {
        var byName: [String: [RemoteFile]] = [:]
        for f in files { byName[f.name, default: []].append(f) }
        var out: [String: RemoteFile] = [:]
        for (name, list) in byName {
            let sorted = list.sorted { $0.id < $1.id }
            out[name] = sorted[0]
            for f in sorted.dropFirst() {
                let stem = name.hasSuffix(".ink.json") ? String(name.dropLast(".ink.json".count)) : name
                let tail = String(f.id.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.suffix(8))
                out["\(stem) (copy \(tail)).ink.json"] = f
            }
        }
        return out
    }

    private func split(_ name: String) -> (String, String) {
        guard let i = name.lastIndex(of: "/") else { return ("", name) }
        return (String(name[..<i]), String(name[name.index(after: i)...]))
    }

    private func topFiles() async throws -> [String: RemoteFile] {
        if let t = state.top, now() - state.topAt < Self.trustMs {
            return Dictionary(t.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        }
        let f = try await ensure()
        let l = try await provider.list(f.top)
        state.top = l.files
        state.topAt = now()
        save()
        return Dictionary(l.files.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private func lookup(_ name: String) async throws -> RemoteFile? {
        let (dir, base) = split(name)
        if dir == Self.dir {
            if state.cursor == nil && state.listedAt == 0 || now() - state.checkedAt > Self.trustMs { try await refresh() }
            return Self.named(state.files)[base]
        }
        if dir.isEmpty { return try await topFiles()[base] }
        return nil
    }

    /// The version the list holds for a name, without any request.
    public func peek(_ name: String) -> String? {
        let (dir, base) = split(name)
        if dir == Self.dir { return Self.named(state.files)[base]?.version }
        return state.top?.first { $0.name == base }?.version
    }

    private func remember(_ f: RemoteFile?, drop: String? = nil) {
        state.files.removeAll { $0.id == drop || $0.id == f?.id }
        if let f { state.files.append(f) }
        save()
    }

    public func list(_ dir: String) async throws -> [FileEntry] {
        let clean = dir.hasSuffix("/") ? String(dir.dropLast()) : dir
        if clean.isEmpty {
            state.topAt = 0
            return try await topFiles().values.map { FileEntry(name: $0.name, mtime: $0.mtime, size: $0.size) }
                .sorted { $0.name < $1.name }
        }
        guard clean == Self.dir else { return [] }
        try await refresh()
        return Self.named(state.files).map { FileEntry(name: "\(Self.dir)/\($0.key)", mtime: $0.value.mtime, size: $0.value.size) }
            .sorted { $0.name < $1.name }
    }

    public func read(_ name: String) async throws -> Data {
        guard let f = try await lookup(name) else { throw CloudError(.notFound, status: 404) }
        do {
            return try await provider.download(f)
        } catch let e as CloudError where e.code == .notFound {
            // Deleted elsewhere: forget it, so the next write makes a new file.
            remember(nil, drop: f.id)
            throw e
        }
    }

    public func write(_ name: String, _ data: Data) async throws {
        try await write(name, data, expect: .any)
    }

    public enum Expect: Equatable {
        /// Write over whatever version the list holds.
        case any
        /// Write only when the file still has this version, or is still missing (nil).
        case version(String?)
    }

    /// Writes one file. With `expect`, a file that changed since that version is a conflict.
    public func write(_ name: String, _ data: Data, expect: Expect) async throws {
        let (dir, base) = split(name)
        guard dir == Self.dir || dir.isEmpty else { throw CloudError(.denied, "outside the folder") }
        let f = try await lookup(name)
        if case .version(let v) = expect, f?.version != v { throw CloudError(.conflict, "changed elsewhere") }
        let fs = try await ensure()
        let parent = dir == Self.dir ? fs.pages : fs.top
        let out: RemoteFile
        do {
            if let f {
                do {
                    out = try await provider.update(f, data)
                } catch let e as CloudError where e.code == .notFound {
                    // Removed elsewhere since the last listing: write it anew.
                    remember(nil, drop: f.id)
                    out = try await provider.create(parent, base, data)
                }
            } else {
                out = try await provider.create(parent, base, data)
            }
        } catch let e as CloudError where e.code == .conflict {
            // Another device wrote first. List again, so the next pass reads its version.
            state.listedAt = 0
            state.checkedAt = 0
            state.top = nil
            save()
            throw e
        }
        if dir == Self.dir {
            remember(out, drop: f?.id)
        } else {
            var top = state.top ?? []
            top.removeAll { $0.name == base }
            top.append(out)
            state.top = top
            save()
        }
    }

    public func remove(_ name: String) async throws {
        guard let f = try await lookup(name) else { throw CloudError(.notFound, status: 404) }
        try await provider.remove(f)
        let (dir, base) = split(name)
        if dir == Self.dir { remember(nil, drop: f.id) } else {
            state.top?.removeAll { $0.name == base }
            save()
        }
    }

    /// Put the folder and its files in the provider's bin.
    public func removeAll() async throws {
        let f = try await ensure()
        try await provider.removeAll(f)
        state = CloudCache()
        cache.set(nil)
    }
}
