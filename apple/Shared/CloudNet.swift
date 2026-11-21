import Foundation

/// The plain problems a cloud can have. The words are the extension's (src/connect/dest.ts and
/// NATIVE_PROTOCOL.md), so a reply can carry them as they are.
public enum CloudCode: String, Sendable {
    case cancelled, denied, offline, full, expired, throttled, server, conflict, reset, locked
    case notSetUp = "not-set-up"
    case notFound = "not-found"
}

public struct CloudError: Error, Equatable, CustomStringConvertible {
    public var code: CloudCode
    public var status: Int
    /// A short note for tests. Never holds a token or a file's text.
    public var detail: String

    public init(_ code: CloudCode, status: Int = 0, _ detail: String = "") {
        self.code = code
        self.status = status
        self.detail = detail
    }

    public var description: String { detail.isEmpty ? code.rawValue : "\(code.rawValue): \(detail)" }

    /// The code of any error, as the extension reads it.
    public static func code(of e: Error) -> String {
        if let c = e as? CloudError { return c.code.rawValue }
        if let s = e as? StoreError { return s.code }
        return "server"
    }

    public static func isCode(_ e: Error, _ c: CloudCode) -> Bool { (e as? CloudError)?.code == c }
}

/// Every host the app may reach, and only when the reader connected a cloud. The same five
/// hosts as the extension (src/cloud/hosts.ts), plus the hosts OneDrive hands downloads to
/// (CLOUD_CONNECT in packages/extension/build/targets.ts). PRIVACY.md lists them.
public enum PinnedHosts {
    public static let exact: Set<String> = [
        "accounts.google.com", // Google's sign-in page, shown in the system sign-in window
        "oauth2.googleapis.com", // Google tokens and giving them back
        "www.googleapis.com", // Google Drive files
        "login.microsoftonline.com", // Microsoft's sign-in page and tokens
        "graph.microsoft.com", // OneDrive files
        "my.microsoftpersonalcontent.com", // OneDrive downloads
    ]
    /// OneDrive downloads, one level of name or more in front.
    public static let suffixes = [".files.1drv.com", ".sharepoint.com"]

    /// True for an https address on a pinned host, on the standard port, without a user name.
    public static func allows(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased(), !host.isEmpty
        else { return false }
        if exact.contains(host) { return true }
        return suffixes.contains { host.hasSuffix($0) && host.count > $0.count && !host.hasPrefix(".") }
    }

    /// True when the address is under one of the prefixes, compared part by part.
    public static func under(_ url: URL, _ prefixes: [String]) -> Bool {
        prefixes.contains { p in
            guard let a = URL(string: p) else { return false }
            return url.scheme?.lowercased() == a.scheme?.lowercased()
                && url.host?.lowercased() == a.host?.lowercased()
                && url.port == a.port
                && url.path.hasPrefix(a.path)
        }
    }
}

/// The one way the app and its extension talk to the network. It refuses any address that is
/// not on the pinned list, before anything is sent, and on every redirect. No cookies, no
/// cache. A test scans the Swift sources and fails on any other network call.
public final class PinnedNet: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private var session: URLSession!
    private static let lock = NSLock()
    private static var sentCount = 0

    /// Requests sent by every PinnedNet in this process. The tests check it stays 0 before connect.
    public static var sent: Int {
        lock.lock()
        defer { lock.unlock() }
        return sentCount
    }

    private static func bump() {
        lock.lock()
        sentCount += 1
        lock.unlock()
    }

    /// `protocols` lets tests answer requests without a network.
    public init(protocols: [AnyClass]? = nil, timeout: TimeInterval = 30) {
        super.init()
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        c.timeoutIntervalForRequest = timeout
        c.waitsForConnectivity = false
        if let protocols { c.protocolClasses = protocols }
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    public func data(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, PinnedHosts.allows(url) else {
            throw CloudError(.denied, "address not allowed")
        }
        Self.bump()
        do {
            let (data, res) = try await session.data(for: request)
            guard let http = res as? HTTPURLResponse else { throw CloudError(.server, "no answer") }
            return (data, http)
        } catch let e as CloudError {
            throw e
        } catch {
            throw CloudError(.offline)
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let next = request.url, PinnedHosts.allows(next) else {
            // Not followed: the caller gets the redirect itself and treats it as a failure.
            completionHandler(nil)
            return
        }
        var r = request
        // A download address carries its own short-lived permission. The token stays with Graph.
        if next.host?.lowercased() != task.originalRequest?.url?.host?.lowercased() {
            r.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        Self.bump()
        completionHandler(r)
    }
}

/// A bearer token that can be renewed once when the provider refuses it.
public struct TokenSource: Sendable {
    public var get: @Sendable () async throws -> String
    public var renew: @Sendable () async throws -> String
    public init(get: @escaping @Sendable () async throws -> String, renew: @escaping @Sendable () async throws -> String) {
        self.get = get
        self.renew = renew
    }
}

/// How hard to try when a provider asks to slow down. The handler has little time, so it
/// tries less than the app.
public struct Retry: Sendable {
    public var tries: Int
    public var baseMs: Double
    public var maxWaitMs: Double
    public var sleep: @Sendable (Double) async -> Void

    public init(tries: Int = 5, baseMs: Double = 1000, maxWaitMs: Double = 60_000,
                sleep: @escaping @Sendable (Double) async -> Void = { ms in
                    try? await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000))
                }) {
        self.tries = tries
        self.baseMs = baseMs
        self.maxWaitMs = maxWaitMs
        self.sleep = sleep
    }

    public static let app = Retry()
    public static let handler = Retry(tries: 3, baseMs: 500, maxWaitMs: 4000)
}

public struct HTTPReply {
    public var status: Int
    public var body: Data
    public var headers: [String: String]
    public var text: String { String(decoding: body, as: UTF8.self) }
    public func header(_ name: String) -> String? { headers[name.lowercased()] }
}

/// One request to a provider, as `send` in src/cloud/http.ts: the address is checked against
/// the provider's own prefixes, a refused token is renewed once, and slow-down answers are
/// waited out with jitter. Returns any other answer for the caller to judge.
public struct CloudHTTP: Sendable {
    public let net: PinnedNet
    public let allow: [String]
    public let retry: Retry

    public init(net: PinnedNet, allow: [String], retry: Retry) {
        self.net = net
        self.allow = allow
        self.retry = retry
    }

    public func send(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil,
                     token: TokenSource? = nil, slowDown: ((Int, String) -> Bool)? = nil) async throws -> HTTPReply {
        guard PinnedHosts.under(url, allow) else { throw CloudError(.denied, "address not allowed") }
        var base = retry.baseMs
        var renewed = false
        var bearer = try await token?.get()
        var i = 0
        while true {
            var req = URLRequest(url: url)
            req.httpMethod = method
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
            if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
            req.httpBody = body
            let (data, res) = try await net.data(req)
            var h: [String: String] = [:]
            for (k, v) in res.allHeaderFields {
                if let k = k as? String, let v = v as? String { h[k.lowercased()] = v }
            }
            let reply = HTTPReply(status: res.statusCode, body: data, headers: h)
            if reply.status == 401, let token, !renewed {
                renewed = true
                bearer = try await token.renew()
                continue
            }
            if reply.status == 401 { throw CloudError(.expired, status: 401) }
            let slow = reply.status == 429 || reply.status == 503 || (slowDown?(reply.status, reply.text) ?? false)
            if slow || [500, 502, 504].contains(reply.status) {
                i += 1
                if i >= retry.tries { throw CloudError(slow ? .throttled : .server, status: reply.status) }
                let wait = Self.retryAfter(reply.header("retry-after")) ?? base * (0.5 + Double.random(in: 0..<0.5))
                await retry.sleep(min(wait, retry.maxWaitMs))
                base *= 2
                continue
            }
            return reply
        }
    }

    static func retryAfter(_ v: String?) -> Double? {
        guard let v else { return nil }
        if let s = Double(v.trimmingCharacters(in: .whitespaces)) { return min(60, max(0, s)) * 1000 }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let d = f.date(from: v) else { return nil }
        return min(60_000, max(0, d.timeIntervalSinceNow * 1000))
    }
}

/// JSON helpers for provider answers.
enum JSONBody {
    static func object(_ d: Data) throws -> [String: Any] {
        guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else {
            throw CloudError(.server, "not JSON")
        }
        return o
    }

    static func data(_ o: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    static func form(_ pairs: [(String, String)]) -> Data {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let s = pairs.map { k, v in
            "\(k.addingPercentEncoding(withAllowedCharacters: allowed) ?? k)=\(v.addingPercentEncoding(withAllowedCharacters: allowed) ?? v)"
        }.joined(separator: "&")
        return Data(s.utf8)
    }
}
