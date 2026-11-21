import Foundation
import XCTest

/// Answers every request of a PinnedNet made with `StubNet.net()`, so no test reaches a network.
/// `answer` sees each request with its body and returns the reply. Requests are recorded.
final class StubProtocol: URLProtocol {
    struct Reply {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        /// Answer with a redirect to this address instead.
        var redirect: URL?
        /// Fail as if there were no network.
        var offline = false

        static func json(_ o: Any, status: Int = 200) -> Reply {
            Reply(status: status, headers: ["Content-Type": "application/json"],
                  body: (try? JSONSerialization.data(withJSONObject: o)) ?? Data())
        }

        static func text(_ s: String, status: Int = 200) -> Reply { Reply(status: status, body: Data(s.utf8)) }
    }

    struct Seen {
        var method: String
        var url: URL
        var headers: [String: String]
        var body: Data
    }

    static let lock = NSLock()
    nonisolated(unsafe) static var answer: (Seen) -> Reply = { _ in Reply(status: 599) }
    nonisolated(unsafe) static var seen: [Seen] = []

    static func reset(_ a: @escaping (Seen) -> Reply) {
        lock.lock()
        answer = a
        seen = []
        lock.unlock()
    }

    static var requests: [Seen] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable {
                let n = s.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                body.append(buf, count: n)
            }
            s.close()
        }
        let s = Seen(method: request.httpMethod ?? "GET", url: request.url!, headers: request.allHTTPHeaderFields ?? [:], body: body)
        Self.lock.lock()
        Self.seen.append(s)
        let a = Self.answer
        Self.lock.unlock()
        let r = a(s)
        if r.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        if let to = r.redirect {
            let res = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": to.absoluteString])!
            var next = URLRequest(url: to)
            next.allHTTPHeaderFields = request.allHTTPHeaderFields
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: res)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let res = HTTPURLResponse(url: request.url!, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: r.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

enum StubNet {
    static func net() -> PinnedNet { PinnedNet(protocols: [StubProtocol.self], timeout: 5) }
    /// Tries quickly and records the waits.
    static func retry(_ waits: WaitLog? = nil, tries: Int = 5) -> Retry {
        Retry(tries: tries, baseMs: 1, maxWaitMs: 10) { ms in waits?.add(ms) }
    }
}

final class WaitLog: @unchecked Sendable {
    private let lock = NSLock()
    private var v: [Double] = []
    func add(_ ms: Double) {
        lock.lock()
        v.append(ms)
        lock.unlock()
    }
    var all: [Double] {
        lock.lock()
        defer { lock.unlock() }
        return v
    }
}

/// The query of a recorded request as a dictionary.
func params(_ u: URL) -> [String: String] {
    var out: [String: String] = [:]
    for i in URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? [] { out[i.name] = i.value ?? "" }
    return out
}

func formOf(_ d: Data) -> [String: String] {
    var c = URLComponents()
    c.percentEncodedQuery = String(decoding: d, as: UTF8.self)
    var out: [String: String] = [:]
    for i in c.queryItems ?? [] { out[i.name] = i.value ?? "" }
    return out
}

/// A small Google Drive in memory: folders, files, versions, the bin, paging, and tokens.
/// Enough of the API for the calls GoogleDrive makes.
final class FakeDrive: @unchecked Sendable {
    struct File {
        var id: String
        var name: String
        var parent: String
        var folder: Bool
        var data: Data
        var version: Int
        var mtime: Date
        var trashed = false
    }

    var files: [String: File] = [:]
    var next = 100
    var pageSize = 1000
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    var offline = false
    /// Answers with a rate-limit 403 this many times before the next answer.
    var throttle = 0
    var validToken = "access-1"
    var refreshes = 0
    var revoked: [String] = []

    func tick() -> Date {
        clock = clock.addingTimeInterval(1)
        return clock
    }

    func add(_ name: String, parent: String, folder: Bool = false, data: Data = Data()) -> String {
        next += 1
        let id = "id\(next)"
        files[id] = File(id: id, name: name, parent: parent, folder: folder, data: data, version: 1, mtime: tick())
        return id
    }

    static func time(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    func meta(_ f: File) -> [String: Any] {
        ["id": f.id, "name": f.name, "modifiedTime": Self.time(f.mtime), "size": String(f.data.count),
         "version": String(f.version), "trashed": f.trashed]
    }

    func pageNames(_ top: String) -> [String] {
        files.values.filter { $0.parent == top && !$0.trashed && !$0.folder }.map(\.name).sorted()
    }

    func install() {
        StubProtocol.reset { [self] s in handle(s) }
    }

    func handle(_ s: StubProtocol.Seen) -> StubProtocol.Reply {
        if offline { return .init(offline: true) }
        let path = s.url.path
        let q = params(s.url)
        if s.url.host == "oauth2.googleapis.com" {
            if path == "/revoke" {
                revoked.append(formOf(s.body)["token"] ?? "")
                return .text("")
            }
            let form = formOf(s.body)
            if form["grant_type"] == "refresh_token" {
                guard form["refresh_token"] == "refresh-1" else { return .json(["error": "invalid_grant"], status: 400) }
                refreshes += 1
                validToken = "access-\(refreshes + 1)"
                return .json(["access_token": validToken, "expires_in": 3600])
            }
            return .json(["access_token": validToken, "expires_in": 3600, "refresh_token": "refresh-1", "scope": Scopes.google])
        }
        guard s.headers["Authorization"] == "Bearer \(validToken)" else { return .json(["error": "invalid"], status: 401) }
        if throttle > 0 {
            throttle -= 1
            return .json(["error": ["errors": [["reason": "rateLimitExceeded"]]]], status: 403)
        }
        let parts = path.split(separator: "/").map(String.init)
        let upload = parts.first == "upload"
        let rest = Array(parts.drop { $0 != "files" })
        if path.hasSuffix("/about") { return .json(["user": ["emailAddress": "reader@example.org"]]) }
        // /files
        if rest == ["files"] && !upload {
            if s.method == "POST" {
                let o = (try? JSONSerialization.jsonObject(with: s.body) as? [String: Any]) ?? [:]
                let id = add(o["name"] as? String ?? "", parent: (o["parents"] as? [String])?.first ?? "", folder: true)
                return .json(["id": id])
            }
            return list(q["q"] ?? "", token: q["pageToken"])
        }
        if rest == ["files"] && upload && s.method == "POST" {
            let (m, data) = multipart(s)
            let id = add(m["name"] as? String ?? "", parent: (m["parents"] as? [String])?.first ?? "", data: data)
            return .json(meta(files[id]!))
        }
        guard rest.count == 2, var f = files[rest[1]] else { return .json(["error": "nf"], status: 404) }
        if upload && s.method == "PATCH" {
            f.data = multipart(s).1
            f.version += 1
            f.mtime = tick()
            files[f.id] = f
            return .json(meta(f))
        }
        switch s.method {
        case "DELETE":
            files[f.id] = nil
            return .text("", status: 204)
        case "PATCH":
            f.trashed = true
            f.mtime = tick()
            files[f.id] = f
            for (id, c) in files where c.parent == f.id { files[id]?.trashed = true }
            return .json(["id": f.id])
        default:
            if q["alt"] == "media" { return f.trashed ? .json([:], status: 404) : .init(body: f.data) }
            return .json(meta(f))
        }
    }

    func multipart(_ s: StubProtocol.Seen) -> ([String: Any], Data) {
        let text = String(decoding: s.body, as: UTF8.self)
        let type = s.headers.first { $0.key.lowercased() == "content-type" }?.value ?? ""
        let b = type.components(separatedBy: "boundary=").last ?? ""
        let parts = text.components(separatedBy: "--\(b)")
        func content(_ p: String) -> String {
            guard let r = p.range(of: "\r\n\r\n") else { return "" }
            var c = String(p[r.upperBound...])
            // "\r\n" is one Character in Swift.
            if c.hasSuffix("\r\n") { c.removeLast() }
            return c
        }
        let meta = (try? JSONSerialization.jsonObject(with: Data(content(parts[1]).utf8)) as? [String: Any]) ?? [:]
        return (meta, Data(content(parts[2]).utf8))
    }

    /// Searches as GoogleDrive asks them: a folder by name, the files in a folder, and changes.
    func list(_ q: String, token: String?) -> StubProtocol.Reply {
        func grab(_ pattern: String) -> String? {
            guard let r = try? NSRegularExpression(pattern: pattern),
                  let m = r.firstMatch(in: q, range: NSRange(q.startIndex..., in: q)),
                  let g = Range(m.range(at: 1), in: q) else { return nil }
            return String(q[g])
        }
        let parent = grab("'([^']*)' in parents") ?? ""
        if parent != "root" && files[parent] == nil { return .json(["error": "File not found"], status: 404) }
        var out = files.values.filter { $0.parent == parent }
        if let name = grab("name = '([^']*)'") { out = out.filter { $0.name == name && $0.folder } }
        if q.contains("trashed = false") { out = out.filter { !$0.trashed } }
        if q.contains("mimeType != ") { out = out.filter { !$0.folder } }
        if let since = grab("modifiedTime > '([^']*)'") {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let d = f.date(from: since) ?? .distantPast
            out = out.filter { $0.mtime > d }
        }
        out.sort { $0.id < $1.id }
        let start = Int(token ?? "0") ?? 0
        let page = Array(out.dropFirst(start).prefix(pageSize))
        var r: [String: Any] = ["files": page.map(meta)]
        if start + pageSize < out.count { r["nextPageToken"] = String(start + pageSize) }
        return .json(r)
    }
}

func freshSpace(_ test: XCTestCase) throws -> SharedSpace {
    let s = SharedSpace(root: try tempDir(test))
    try FileManager.default.createDirectory(at: s.storeRoot, withIntermediateDirectories: true)
    return s
}

func setup(_ space: SharedSpace, secrets: SecretStore = MemorySecrets(), ids: ClientIds = ClientIds(google: "123-abc.apps.googleusercontent.com", microsoft: "00000000-0000-0000-0000-000000000001"),
           retry: Retry = StubNet.retry()) -> CloudSetup {
    CloudSetup(space: space, secrets: secrets, ids: ids, bundleId: "org.example.test", folderName: "Notes App",
               net: StubNet.net(), retry: retry)
}

func signIn(_ s: SecretStore, _ p: ProviderID, access: String = "access-1", exp: Int64 = nowMillis() + 3_600_000) {
    try! s.setJSON(Tokens.key(p), Tokens(access: access, exp: exp, refresh: "refresh-1", account: "reader@example.org"))
}
