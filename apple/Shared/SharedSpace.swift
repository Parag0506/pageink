import Foundation
#if os(macOS)
import Security
#endif

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
        let id = bundle.object(forInfoDictionaryKey: "InkAppGroup") as? String ?? ""
        guard let url = sharedRoot(group: id, home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true),
                                   local: localStore(),
                                   lookup: { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) })
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

    /// The folder the app and the extension share, or nil when this build has none.
    ///
    /// `local` is the folder of a Mac build signed to run locally (`localStore`). It comes
    /// first, and the system is then not asked about a group at all.
    ///
    /// Otherwise it is the folder the system gives for the App Group, unless that folder is
    /// this process's own home. On macOS a group named exactly like the app is answered with
    /// the app's own container, and the extension gets a different folder for the same name.
    /// That is what a build with no team prefix has. Using it would show an empty Notes list
    /// beside notes that Safari keeps elsewhere, so it counts as no group.
    static func sharedRoot(group id: String, home: URL, local: URL? = nil, lookup: (String) -> URL?) -> URL? {
        if let local { return local }
        guard !id.isEmpty, let url = lookup(id) else { return nil }
        func path(_ u: URL) -> String { u.standardizedFileURL.resolvingSymlinksInPath().path }
        return path(url) == path(home) ? nil : url
    }

    /// The sandbox exception that only the Mac build signed to run locally carries
    /// (Config/Local-macOS.entitlements): folders under the reader's home, each ending in "/".
    static let localStoreEntitlement = "com.apple.security.temporary-exception.files.home-relative-path.read-write"

    /// The folder that exception names, in the reader's real home, or nil when there is none.
    /// Only a plain folder under Library is taken: anything else is not ours.
    static func localStore(exceptions: [String]?, userHome: String) -> URL? {
        guard let path = exceptions?.first, path.hasPrefix("/Library/"), path.hasSuffix("/"),
              !path.split(separator: "/").contains(".."), !userHome.isEmpty
        else { return nil }
        return URL(fileURLWithPath: userHome + String(path.dropLast()), isDirectory: true)
    }

    /// Where a Mac build signed to run locally keeps notes, or nil in every other build.
    /// With no team, macOS does not let the app and the extension share an App Group container,
    /// so `build.sh mac-local` signs both with one exception for one folder. Each side reads the
    /// folder from its own signature, so the two cannot disagree about where it is.
    static func localStore() -> URL? {
        #if os(macOS)
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(task, localStoreEntitlement as CFString, nil),
              let dir = getpwuid(getuid())?.pointee.pw_dir
        else { return nil }
        // The sandbox gives a container as the home folder. The exception is for the real one.
        return localStore(exceptions: value as? [String], userHome: String(cString: dir))
        #else
        return nil
        #endif
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
