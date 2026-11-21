import Foundation

public struct FileEntry: Equatable, Sendable {
    /// Full relative name, such as "pages/3k9x2a.ink.json".
    public var name: String
    /// Modification time in epoch milliseconds.
    public var mtime: Int64
    public var size: Int64
    /// The file lives in iCloud and is not downloaded yet. Its content is unknown.
    public var placeholder: Bool = false
}

public enum StoreError: Error, Equatable {
    case badName
    case notFound
    case denied
    case failed(String)

    /// The error code sent to the extension (NATIVE_PROTOCOL.md, "Replies").
    public var code: String {
        switch self {
        case .badName: return "bad-name"
        case .notFound: return "not-found"
        case .denied: return "denied"
        case .failed(let m): return m
        }
    }
}

/// Reads and writes whole files under one root folder.
/// Writes go to a hidden temporary file that is then renamed, so a sync service never sees half a file.
/// Folders from a cloud provider are used through file coordination.
public final class DirectoryStore {
    public let root: URL
    public let coordinated: Bool
    private let fm = FileManager.default

    public init(root: URL, coordinated: Bool) {
        self.root = root.standardizedFileURL
        self.coordinated = coordinated
    }

    // MARK: Paths

    /// The URL for a relative name, after checking that it stays inside the root, links included.
    public func url(for name: String) throws -> URL {
        guard let parts = SafeName.components(name) else { throw StoreError.badName }
        var u = root
        for p in parts { u.appendPathComponent(p) }
        try checkInside(u.deletingLastPathComponent())
        return u
    }

    private func checkInside(_ dir: URL) throws {
        // Walk up to the nearest folder that exists, then compare real paths.
        var probe = dir
        while !fm.fileExists(atPath: probe.path), probe.path.count > root.path.count {
            probe.deleteLastPathComponent()
        }
        let realRoot = root.resolvingSymlinksInPath().path
        let real = probe.resolvingSymlinksInPath().path
        if real != realRoot && !real.hasPrefix(realRoot + "/") { throw StoreError.badName }
    }

    // MARK: Operations

    /// Files directly inside `dir`. A missing folder is an empty list.
    public func list(_ dir: String) throws -> [FileEntry] {
        let d: URL
        let prefix: String
        if dir.isEmpty {
            d = root
            prefix = ""
        } else {
            guard let parts = SafeName.components(dir) else { throw StoreError.badName }
            var u = root
            for p in parts { u.appendPathComponent(p) }
            try checkInside(u)
            d = u
            prefix = parts.joined(separator: "/") + "/"
        }
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: d.path, isDirectory: &isDir) else { return [] }
        guard isDir.boolValue else { return [] }
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        let items: [URL]
        do {
            items = try fm.contentsOfDirectory(at: d, includingPropertiesForKeys: keys, options: [])
        } catch {
            throw Self.map(error)
        }
        var out: [String: FileEntry] = [:]
        for item in items {
            let base = item.lastPathComponent
            let values = try? item.resourceValues(forKeys: Set(keys))
            guard values?.isRegularFile ?? false else { continue }
            let mtime = Self.millis(values?.contentModificationDate ?? Date(timeIntervalSince1970: 0))
            if let real = Self.placeholderTarget(base) {
                // iCloud keeps ".name.icloud" until the file is downloaded.
                if out[prefix + real] == nil {
                    out[prefix + real] = FileEntry(name: prefix + real, mtime: mtime, size: 0, placeholder: true)
                }
                continue
            }
            if base.hasPrefix(".") { continue }
            let size = Int64(values?.fileSize ?? 0)
            out[prefix + base] = FileEntry(name: prefix + base, mtime: mtime, size: size)
        }
        return out.values.sorted { $0.name < $1.name }
    }

    public func read(_ name: String) throws -> Data {
        let u = try url(for: name)
        return try coordinate(reading: u) { u in
            do {
                return try Data(contentsOf: u)
            } catch {
                throw Self.map(error)
            }
        }
    }

    /// Creates or replaces one file, creating its folder. `mtime` sets the modification time.
    public func write(_ name: String, _ data: Data, mtime: Int64? = nil) throws {
        let u = try url(for: name)
        do {
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        } catch {
            throw Self.map(error)
        }
        try coordinate(writing: u, options: .forReplacing) { u in
            let tmp = u.deletingLastPathComponent()
                .appendingPathComponent(".\(u.lastPathComponent).\(UUID().uuidString).tmp")
            do {
                try data.write(to: tmp)
                if let mtime {
                    let date = Date(timeIntervalSince1970: Double(mtime) / 1000)
                    try fm.setAttributes([.modificationDate: date], ofItemAtPath: tmp.path)
                }
            } catch {
                try? fm.removeItem(at: tmp)
                throw Self.map(error)
            }
            // rename(2) replaces the target in one step.
            if Foundation.rename(tmp.path, u.path) != 0 {
                let e = errno
                try? fm.removeItem(at: tmp)
                throw (e == EACCES || e == EPERM) ? StoreError.denied : StoreError.failed("rename failed (\(e))")
            }
        }
    }

    public func remove(_ name: String) throws {
        let u = try url(for: name)
        if !fm.fileExists(atPath: u.path) && !fm.fileExists(atPath: Self.placeholderURL(u).path) {
            throw StoreError.notFound
        }
        try coordinate(writing: u, options: .forDeleting) { u in
            do {
                if fm.fileExists(atPath: u.path) {
                    try fm.removeItem(at: u)
                } else {
                    try fm.removeItem(at: Self.placeholderURL(u))
                }
            } catch {
                throw Self.map(error)
            }
        }
    }

    /// Current entry for one name, or nil when there is no such file.
    public func entry(_ name: String) throws -> FileEntry? {
        guard SafeName.isSafe(name) else { throw StoreError.badName }
        let dir = (name as NSString).deletingLastPathComponent
        return try list(dir).first { $0.name == name }
    }

    /// Asks iCloud to fetch a file that is only a placeholder.
    public func startDownload(_ name: String) {
        guard let u = try? url(for: name) else { return }
        try? fm.startDownloadingUbiquitousItem(at: u)
    }

    // MARK: Helpers

    private func coordinate<T>(reading u: URL, _ body: (URL) throws -> T) throws -> T {
        guard coordinated else { return try body(u) }
        var result: Result<T, Error> = .failure(StoreError.failed("coordination failed"))
        var cerr: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: u, options: [], error: &cerr) { u in
            result = Result { try body(u) }
        }
        if let cerr { throw Self.map(cerr) }
        return try result.get()
    }

    private func coordinate(writing u: URL, options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> Void) throws {
        guard coordinated else { return try body(u) }
        var result: Result<Void, Error> = .failure(StoreError.failed("coordination failed"))
        var cerr: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: u, options: options, error: &cerr) { u in
            result = Result { try body(u) }
        }
        if let cerr { throw Self.map(cerr) }
        try result.get()
    }

    static func placeholderTarget(_ base: String) -> String? {
        guard base.hasPrefix("."), base.hasSuffix(".icloud"), base.count > ".x.icloud".count - 1 else { return nil }
        let inner = String(base.dropFirst().dropLast(".icloud".count))
        return inner.isEmpty || inner.hasPrefix(".") ? nil : inner
    }

    static func placeholderURL(_ u: URL) -> URL {
        u.deletingLastPathComponent().appendingPathComponent(".\(u.lastPathComponent).icloud")
    }

    public static func millis(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1000).rounded()) }

    static func map(_ error: Error) -> StoreError {
        if let e = error as? StoreError { return e }
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain {
            switch CocoaError.Code(rawValue: ns.code) {
            case .fileNoSuchFile, .fileReadNoSuchFile:
                return .notFound
            case .fileReadNoPermission, .fileWriteNoPermission:
                return .denied
            case .fileWriteOutOfSpace:
                return .failed("disk full")
            default:
                break
            }
            if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError, under.domain == NSPOSIXErrorDomain {
                return mapPosix(Int32(under.code))
            }
        }
        if ns.domain == NSPOSIXErrorDomain { return mapPosix(Int32(ns.code)) }
        return .failed(ns.localizedDescription)
    }

    private static func mapPosix(_ code: Int32) -> StoreError {
        switch code {
        case ENOENT: return .notFound
        case EACCES, EPERM: return .denied
        default: return .failed(String(cString: strerror(code)))
        }
    }
}
