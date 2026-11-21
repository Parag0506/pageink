import Foundation

/// The folder the reader picked, kept as a bookmark so access survives restarts.
public struct FolderLink: Codable, Equatable {
    public var bookmark: Data
    public var name: String
    public var pickedAt: Date

    public init(bookmark: Data, name: String, pickedAt: Date) {
        self.bookmark = bookmark
        self.name = name
        self.pickedAt = pickedAt
    }
}

/// What the extension found the last time it tried to open the reader's folder itself.
public struct ExtensionAccess: Codable, Equatable {
    public var direct: Bool
    public var at: Date
    public var detail: String
}

/// Whether Safari lets the extension run on every website, as the extension last said.
/// With All Websites on Ask, the Pencil does not write until the reader taps the toolbar button.
public struct SiteAccess: Codable, Equatable {
    public var all: Bool
    public var at: Date
    public init(all: Bool, at: Date) {
        self.all = all
        self.at = at
    }
}

/// mtimes on both sides after the last mirror, per file.
public struct MirrorBase: Codable, Equatable {
    public var a: Int64?
    public var b: Int64?
    public init(a: Int64?, b: Int64?) {
        self.a = a
        self.b = b
    }
}

public struct MirrorState: Codable, Equatable {
    public var lastMirror: Date?
    public var files: [String: MirrorBase] = [:]
    public init(lastMirror: Date? = nil, files: [String: MirrorBase] = [:]) {
        self.lastMirror = lastMirror
        self.files = files
    }
}

/// The App Group container that the app and the extension share.
/// Notes live in `Store/pages/<hash>.ink.json`, small state files in `State/`.
/// Notes here survive clearing Safari's website data and removing only the extension.
public final class SharedSpace: @unchecked Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    /// The App Group container named in Info.plist, or nil when this build has no usable group.
    public static func appGroup(bundle: Bundle = .main) -> SharedSpace? {
        guard let id = bundle.object(forInfoDictionaryKey: "InkAppGroup") as? String, !id.isEmpty,
              let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
        else { return nil }
        let space = SharedSpace(root: url)
        // The path is returned even when the sandbox denies it, so check that it is usable.
        do {
            try FileManager.default.createDirectory(at: space.storeRoot, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: space.stateDir, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        return space
    }

    public var storeRoot: URL { root.appendingPathComponent("Store", isDirectory: true) }
    var stateDir: URL { root.appendingPathComponent("State", isDirectory: true) }

    public func store() -> DirectoryStore { DirectoryStore(root: storeRoot, coordinated: false) }

    // MARK: State files

    public var folderLink: FolderLink? {
        get { load("folder.json") }
        set { save(newValue, "folder.json") }
    }

    public var extensionAccess: ExtensionAccess? {
        get { load("extension.json") }
        set { save(newValue, "extension.json") }
    }

    public var siteAccess: SiteAccess? {
        get { load("websites.json") }
        set { save(newValue, "websites.json") }
    }

    public var mirrorState: MirrorState {
        get { load("mirror.json") ?? MirrorState() }
        set { save(newValue, "mirror.json") }
    }

    func load<T: Decodable>(_ file: String) -> T? {
        guard let data = try? Data(contentsOf: stateDir.appendingPathComponent(file)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func save<T: Encodable>(_ value: T?, _ file: String) {
        let u = stateDir.appendingPathComponent(file)
        guard let value else {
            try? FileManager.default.removeItem(at: u)
            return
        }
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(value) { try? data.write(to: u, options: .atomic) }
    }
}

/// Opens the folder a bookmark points to, with its security scope.
public final class ScopedFolder {
    public let url: URL
    private let scoped: Bool

    init(url: URL, scoped: Bool) {
        self.url = url
        self.scoped = scoped
    }

    deinit {
        if scoped { url.stopAccessingSecurityScopedResource() }
    }

    public static var bookmarkCreateOptions: URL.BookmarkCreationOptions {
        #if os(macOS)
        return [.withSecurityScope]
        #else
        return []
        #endif
    }

    static var bookmarkResolveOptions: URL.BookmarkResolutionOptions {
        #if os(macOS)
        return [.withSecurityScope]
        #else
        return []
        #endif
    }

    public enum OpenError: Error, Equatable {
        case unresolved(String)
        case noAccess
    }

    /// Resolves the bookmark and proves access by listing the folder.
    /// `stale` reports that the bookmark should be made again while access lasts.
    public static func open(_ bookmark: Data) -> Result<(ScopedFolder, stale: Bool), OpenError> {
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: bookmark, options: bookmarkResolveOptions,
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            return .failure(.unresolved((error as NSError).localizedDescription))
        }
        let scoped = url.startAccessingSecurityScopedResource()
        let folder = ScopedFolder(url: url, scoped: scoped)
        var cerr: NSError?
        var ok = false
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &cerr) { u in
            ok = (try? FileManager.default.contentsOfDirectory(atPath: u.path)) != nil
        }
        guard ok, cerr == nil else { return .failure(.noAccess) }
        return .success((folder, stale))
    }
}
