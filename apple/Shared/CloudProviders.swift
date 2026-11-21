import Foundation

/// A file in a cloud. As `RemoteFile` in packages/extension/src/cloud/provider.ts.
public struct RemoteFile: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    /// Epoch ms, from the provider's clock.
    public var mtime: Int64
    public var size: Int64
    /// Changes on every write: Drive's version number, Graph's eTag.
    public var version: String

    public init(id: String, name: String, mtime: Int64, size: Int64, version: String) {
        self.id = id
        self.name = name
        self.mtime = mtime
        self.size = size
        self.version = version
    }
}

public struct Folders: Codable, Equatable, Sendable {
    /// The visible top folder the reader can open. The lock file lives here.
    public var top: String
    /// Its "pages" folder.
    public var pages: String
}

public struct Listing: Sendable {
    public var files: [RemoteFile]
    /// Where a change check starts next time. Nil when the provider has no cheap check.
    public var cursor: String?
}

public struct Changes: Sendable {
    public var files: [RemoteFile]
    /// Ids removed since the cursor.
    public var gone: [String]
    public var cursor: String
}

/// One storage service. Everything else (names, caching, conflicts) is shared in CloudFolder.
public protocol CloudProvider: Sendable {
    var id: ProviderID { get }
    /// Find or make the top folder and its pages folder.
    func folders() async throws -> Folders
    func list(_ folder: String) async throws -> Listing
    /// Throws "reset" when the cursor is too old.
    func changes(_ folder: String, _ cursor: String) async throws -> Changes
    func download(_ f: RemoteFile) async throws -> Data
    /// Throws "conflict" when the provider can tell the name is already taken.
    func create(_ folder: String, _ name: String, _ data: Data) async throws -> RemoteFile
    /// Throws "conflict" when f.version is no longer the file's version.
    func update(_ f: RemoteFile, _ data: Data) async throws -> RemoteFile
    func remove(_ f: RemoteFile) async throws
    /// Put the top folder and everything in it in the provider's bin. Only after a clear yes.
    func removeAll(_ f: Folders) async throws
    /// The account to show, when the provider can say.
    func account() async -> String?
}

public enum CloudAPI {
    public static let drive = "https://www.googleapis.com/drive/v3"
    public static let driveUpload = "https://www.googleapis.com/upload/drive/v3"
    public static let graph = "https://graph.microsoft.com/v1.0"
}

func iso(_ s: String?) -> Int64 {
    guard let s else { return 0 }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
    f.formatOptions = [.withInternetDateTime]
    if let d = f.date(from: s) { return Int64((d.timeIntervalSince1970 * 1000).rounded()) }
    return 0
}

func enc(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

func query(_ base: String, _ items: [(String, String)]) -> URL {
    var c = URLComponents(string: base)!
    c.percentEncodedQuery = items.map { "\(enc($0.0))=\(enc($0.1))" }.joined(separator: "&")
    return c.url!
}

// MARK: Google Drive

/// Google Drive with `drive.file`: the app sees only the files it made, in one visible folder
/// named after the product in My Drive. As src/cloud/google.ts. Drive allows two files with
/// one name, so files are found by id; CloudFolder maps names to ids.
public struct GoogleDrive: CloudProvider {
    public let id = ProviderID.google
    let http: CloudHTTP
    let token: TokenSource
    let folderName: String
    static let folderType = "application/vnd.google-apps.folder"
    static let fields = "id,name,modifiedTime,size,version,trashed"
    /// Drive's limit for a multipart upload. Larger files use a resumable upload.
    static let multipartMax = 5 * 1024 * 1024

    public init(net: PinnedNet, retry: Retry, token: TokenSource, folderName: String) {
        http = CloudHTTP(net: net, allow: [CloudAPI.drive, CloudAPI.driveUpload], retry: retry)
        self.token = token
        self.folderName = folderName
    }

    static func slowDown(_ status: Int, _ body: String) -> Bool {
        status == 403 && (body.contains("rateLimitExceeded") || body.contains("userRateLimitExceeded"))
    }

    func call(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) async throws -> HTTPReply {
        let r = try await http.send(url, method: method, headers: headers, body: body, token: token, slowDown: Self.slowDown)
        let s = r.status
        if (200..<300).contains(s) { return r }
        if s == 404 { throw CloudError(.notFound, status: s) }
        if s == 403 && (r.text.contains("storageQuotaExceeded") || r.text.contains("quotaExceeded")) {
            throw CloudError(.full, status: s)
        }
        if s == 403 { throw CloudError(.denied, status: s) }
        if s == 412 { throw CloudError(.conflict, status: s) }
        throw CloudError(.server, status: s)
    }

    func get(_ path: String, _ items: [(String, String)]) async throws -> [String: Any] {
        try JSONBody.object(try await call(query(CloudAPI.drive + path, items)).body)
    }

    static func remote(_ o: [String: Any]) -> RemoteFile {
        let size = (o["size"] as? String).flatMap { Int64($0) } ?? (o["size"] as? NSNumber)?.int64Value ?? 0
        let version = (o["version"] as? String) ?? (o["version"] as? NSNumber)?.stringValue ?? (o["modifiedTime"] as? String) ?? ""
        return RemoteFile(id: o["id"] as? String ?? "", name: o["name"] as? String ?? "",
                          mtime: iso(o["modifiedTime"] as? String), size: size, version: version)
    }

    /// Quote a value for a Drive search.
    static func q(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

    func find(_ name: String, _ parent: String) async throws -> String? {
        let r = try await get("/files", [
            ("q", "name = \(Self.q(name)) and mimeType = \(Self.q(Self.folderType)) and \(Self.q(parent)) in parents and trashed = false"),
            ("fields", "files(id,name)"), ("spaces", "drive"), ("pageSize", "10"),
        ])
        return ((r["files"] as? [[String: Any]])?.first?["id"]) as? String
    }

    func mkdir(_ name: String, _ parent: String) async throws -> String {
        let r = try await call(query(CloudAPI.drive + "/files", [("fields", "id")]), method: "POST",
                               headers: ["Content-Type": "application/json"],
                               body: JSONBody.data(["name": name, "mimeType": Self.folderType, "parents": [parent]]))
        guard let id = try JSONBody.object(r.body)["id"] as? String else { throw CloudError(.server, "no id") }
        return id
    }

    public func folders() async throws -> Folders {
        let top: String
        if let t = try await find(folderName, "root") { top = t } else { top = try await mkdir(folderName, "root") }
        let pages: String
        if let p = try await find("pages", top) { pages = p } else { pages = try await mkdir("pages", top) }
        return Folders(top: top, pages: pages)
    }

    private func pages(_ q: String) async throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        var pageToken = ""
        repeat {
            var items = [("q", q), ("fields", "nextPageToken,files(\(Self.fields))"), ("spaces", "drive"), ("pageSize", "1000")]
            if !pageToken.isEmpty { items.append(("pageToken", pageToken)) }
            let r = try await get("/files", items)
            out += r["files"] as? [[String: Any]] ?? []
            pageToken = r["nextPageToken"] as? String ?? ""
        } while !pageToken.isEmpty
        return out
    }

    public func list(_ folder: String) async throws -> Listing {
        // Only files: the top folder also holds the pages folder.
        let files = try await pages("\(Self.q(folder)) in parents and trashed = false and mimeType != \(Self.q(Self.folderType))")
            .filter { ($0["trashed"] as? Bool) != true }.map(Self.remote)
        // The change check asks for files changed after the newest time seen here.
        return Listing(files: files, cursor: String(files.map(\.mtime).max() ?? 0))
    }

    public func changes(_ folder: String, _ cursor: String) async throws -> Changes {
        // A few seconds back, so a write that landed in the same second is not missed.
        let seen: Int64 = Int64(cursor) ?? 0
        let sinceMs: Int64 = max(0, seen - 5000)
        let since = Date(timeIntervalSince1970: Double(sinceMs) / 1000)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var files: [RemoteFile] = []
        var gone: [String] = []
        var newest = seen
        // Files moved to the bin are asked for too: they are the removals.
        for o in try await pages("\(Self.q(folder)) in parents and modifiedTime > \(Self.q(f.string(from: since)))") {
            let r = Self.remote(o)
            newest = max(newest, r.mtime)
            if (o["trashed"] as? Bool) == true { gone.append(r.id) } else { files.append(r) }
        }
        return Changes(files: files, gone: gone, cursor: String(newest))
    }

    public func download(_ f: RemoteFile) async throws -> Data {
        try await call(query(CloudAPI.drive + "/files/\(enc(f.id))", [("alt", "media")])).body
    }

    /// Multipart for small files, a resumable upload for large ones.
    func upload(_ method: String, _ path: String, _ meta: [String: Any], _ data: Data) async throws -> RemoteFile {
        if data.count < Self.multipartMax {
            let b = "ink" + PKCE.randomText(12).filter { $0.isLetter || $0.isNumber }
            var body = Data("--\(b)\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n".utf8)
            body += JSONBody.data(meta)
            body += Data("\r\n--\(b)\r\ncontent-type: application/json\r\n\r\n".utf8)
            body += data
            body += Data("\r\n--\(b)--\r\n".utf8)
            let r = try await call(query(CloudAPI.driveUpload + path, [("uploadType", "multipart"), ("fields", Self.fields)]),
                                   method: method, headers: ["Content-Type": "multipart/related; boundary=\(b)"], body: body)
            return Self.remote(try JSONBody.object(r.body))
        }
        let start = try await call(query(CloudAPI.driveUpload + path, [("uploadType", "resumable"), ("fields", Self.fields)]),
                                   method: method,
                                   headers: ["Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/json"],
                                   body: JSONBody.data(meta))
        guard let at = start.header("location"), let u = URL(string: at) else { throw CloudError(.server, "no upload address") }
        let r = try await call(u, method: "PUT", headers: ["Content-Type": "application/json"], body: data)
        return Self.remote(try JSONBody.object(r.body))
    }

    public func create(_ folder: String, _ name: String, _ data: Data) async throws -> RemoteFile {
        try await upload("POST", "/files", ["name": name, "parents": [folder], "mimeType": "application/json"], data)
    }

    public func update(_ f: RemoteFile, _ data: Data) async throws -> RemoteFile {
        // Drive has no conditional write, so the version is checked just before. Two devices
        // writing in the same moment are caught by the next sync's merge.
        let o = try await get("/files/\(enc(f.id))", [("fields", Self.fields)])
        if (o["trashed"] as? Bool) == true { throw CloudError(.notFound, status: 404) }
        if Self.remote(o).version != f.version { throw CloudError(.conflict, status: 412) }
        return try await upload("PATCH", "/files/\(enc(f.id))", [:], data)
    }

    public func remove(_ f: RemoteFile) async throws {
        do {
            _ = try await call(URL(string: CloudAPI.drive + "/files/\(enc(f.id))")!, method: "DELETE")
        } catch let e as CloudError where e.code == .notFound {}
    }

    public func removeAll(_ f: Folders) async throws {
        // The bin, not a delete, so the reader can still get the files back from Drive.
        _ = try await call(query(CloudAPI.drive + "/files/\(enc(f.top))", [("fields", "id")]), method: "PATCH",
                           headers: ["Content-Type": "application/json"], body: JSONBody.data(["trashed": true]))
    }

    /// CHECK with a real client id: about.get answers with drive.file and gives the address.
    public func account() async -> String? {
        guard let r = try? await get("/about", [("fields", "user(emailAddress,displayName)")]),
              let u = r["user"] as? [String: Any] else { return nil }
        return (u["emailAddress"] ?? u["displayName"]) as? String
    }
}

// MARK: OneDrive

/// OneDrive through Microsoft Graph with `Files.ReadWrite.AppFolder`: only the app folder
/// (Apps/<app name>). Writes are conditional: an update carries the eTag it read, and a new
/// file fails if the name is taken. As src/cloud/onedrive.ts.
public struct OneDrive: CloudProvider {
    public let id = ProviderID.onedrive
    let http: CloudHTTP
    let token: TokenSource
    static let select = "id,name,eTag,lastModifiedDateTime,size,file,folder,deleted,parentReference"

    public init(net: PinnedNet, retry: Retry, token: TokenSource) {
        http = CloudHTTP(net: net, allow: [CloudAPI.graph], retry: retry)
        self.token = token
    }

    func call(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) async throws -> HTTPReply {
        // Next and delta links come from Graph. They must still point at Graph.
        guard PinnedHosts.under(url, [CloudAPI.graph]) else { throw CloudError(.denied, "link outside Graph") }
        let r = try await http.send(url, method: method, headers: headers, body: body, token: token)
        let s = r.status
        if (200..<300).contains(s) { return r }
        if s == 404 { throw CloudError(.notFound, status: s) }
        if s == 409 || s == 412 { throw CloudError(.conflict, status: s) }
        if s == 410 { throw CloudError(.reset, status: s) }
        if s == 507 || r.text.contains("quotaLimitReached") || r.text.contains("insufficientStorage") {
            throw CloudError(.full, status: s)
        }
        if s == 403 { throw CloudError(.denied, status: s) }
        throw CloudError(.server, status: s)
    }

    static func remote(_ o: [String: Any]) -> RemoteFile {
        RemoteFile(id: o["id"] as? String ?? "", name: o["name"] as? String ?? "",
                   mtime: iso(o["lastModifiedDateTime"] as? String),
                   size: (o["size"] as? NSNumber)?.int64Value ?? 0, version: o["eTag"] as? String ?? "")
    }

    func item(_ path: String) async throws -> [String: Any] {
        try JSONBody.object(try await call(URL(string: CloudAPI.graph + path)!).body)
    }

    func children(_ id: String) async throws -> [[String: Any]] {
        var out: [[String: Any]] = []
        var next: URL? = query(CloudAPI.graph + "/me/drive/items/\(enc(id))/children", [("$select", Self.select), ("$top", "200")])
        while let u = next {
            let r = try JSONBody.object(try await call(u).body)
            out += r["value"] as? [[String: Any]] ?? []
            next = (r["@odata.nextLink"] as? String).flatMap(URL.init(string:))
        }
        return out
    }

    /// Every page of a delta, to its delta link.
    func delta(_ start: URL) async throws -> (items: [[String: Any]], link: String) {
        var items: [[String: Any]] = []
        var next: URL? = start
        while let u = next {
            let r = try JSONBody.object(try await call(u).body)
            items += r["value"] as? [[String: Any]] ?? []
            if let link = r["@odata.deltaLink"] as? String { return (items, link) }
            next = (r["@odata.nextLink"] as? String).flatMap(URL.init(string:))
        }
        throw CloudError(.reset, "no delta link")
    }

    /// CHECK: delta on a folder below the drive's root works for personal accounts; work and
    /// school accounts may refuse it. Then the cursor is nil and each sync lists the folder.
    func latest(_ folder: String) async throws -> String? {
        do {
            return try await delta(query(CloudAPI.graph + "/me/drive/items/\(enc(folder))/delta", [("token", "latest")])).link
        } catch let e as CloudError where [.server, .denied, .reset].contains(e.code) {
            return nil
        }
    }

    public func folders() async throws -> Folders {
        // Asking for the app folder makes it the first time.
        guard let top = try await item("/me/drive/special/approot?$select=id,name")["id"] as? String else {
            throw CloudError(.server, "no app folder")
        }
        do {
            if let p = try await item("/me/drive/special/approot:/pages?$select=id")["id"] as? String {
                return Folders(top: top, pages: p)
            }
        } catch let e as CloudError where e.code == .notFound {}
        do {
            let r = try await call(URL(string: CloudAPI.graph + "/me/drive/items/\(enc(top))/children")!, method: "POST",
                                   headers: ["Content-Type": "application/json"],
                                   body: JSONBody.data(["name": "pages", "folder": [String: Any](),
                                                        "@microsoft.graph.conflictBehavior": "fail"]))
            guard let p = try JSONBody.object(r.body)["id"] as? String else { throw CloudError(.server, "no id") }
            return Folders(top: top, pages: p)
        } catch let e as CloudError where e.code == .conflict {
            // Another device made it in the meantime.
            guard let p = try await item("/me/drive/special/approot:/pages?$select=id")["id"] as? String else {
                throw CloudError(.server, "no pages folder")
            }
            return Folders(top: top, pages: p)
        }
    }

    public func list(_ folder: String) async throws -> Listing {
        let files = try await children(folder).filter { $0["file"] != nil && $0["deleted"] == nil }.map(Self.remote)
        return Listing(files: files, cursor: try await latest(folder))
    }

    public func changes(_ folder: String, _ cursor: String) async throws -> Changes {
        guard let u = URL(string: cursor) else { throw CloudError(.reset, "bad cursor") }
        let (items, link) = try await delta(u)
        var files: [RemoteFile] = []
        var gone: [String] = []
        for i in items {
            let id = i["id"] as? String ?? ""
            if id == folder { continue }
            let parent = (i["parentReference"] as? [String: Any])?["id"] as? String
            if i["deleted"] != nil { gone.append(id) }
            else if i["file"] != nil && (parent == nil || parent == folder) { files.append(Self.remote(i)) }
            // A file moved out of the folder no longer belongs to it.
            else if i["file"] != nil { gone.append(id) }
        }
        return Changes(files: files, gone: gone, cursor: link)
    }

    /// CHECK: Graph answers with a redirect to a short-lived address on its file hosts
    /// (*.files.1drv.com, *.sharepoint.com or my.microsoftpersonalcontent.com). PinnedNet
    /// follows it only to those hosts, without the token.
    public func download(_ f: RemoteFile) async throws -> Data {
        try await call(URL(string: CloudAPI.graph + "/me/drive/items/\(enc(f.id))/content")!).body
    }

    public func create(_ folder: String, _ name: String, _ data: Data) async throws -> RemoteFile {
        let u = URL(string: CloudAPI.graph + "/me/drive/items/\(enc(folder)):/\(enc(name)):/content?@microsoft.graph.conflictBehavior=fail")!
        let r = try await call(u, method: "PUT", headers: ["Content-Type": "application/json"], body: data)
        return Self.remote(try JSONBody.object(r.body))
    }

    public func update(_ f: RemoteFile, _ data: Data) async throws -> RemoteFile {
        let r = try await call(URL(string: CloudAPI.graph + "/me/drive/items/\(enc(f.id))/content")!, method: "PUT",
                               headers: ["Content-Type": "application/json", "If-Match": f.version], body: data)
        return Self.remote(try JSONBody.object(r.body))
    }

    public func remove(_ f: RemoteFile) async throws {
        do {
            _ = try await call(URL(string: CloudAPI.graph + "/me/drive/items/\(enc(f.id))")!, method: "DELETE")
        } catch let e as CloudError where e.code == .notFound {}
    }

    public func removeAll(_ f: Folders) async throws {
        // Deleted items go to the OneDrive recycle bin, where the reader can still get them.
        for i in try await children(f.top) {
            do {
                _ = try await call(URL(string: CloudAPI.graph + "/me/drive/items/\(enc(i["id"] as? String ?? ""))")!, method: "DELETE")
            } catch let e as CloudError where e.code == .notFound {}
        }
    }

    /// The account comes from the sign-in's id token instead.
    public func account() async -> String? { nil }
}
