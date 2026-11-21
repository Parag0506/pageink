import XCTest

/// The privacy promise, checked: the app and its extension reach only the pinned hosts, and
/// only through PinnedNet.
final class NetworkRuleTests: XCTestCase {
    static let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    func testOnlyPinnedHostsAreAllowed() {
        for ok in [
            "https://accounts.google.com/o/oauth2/v2/auth", "https://oauth2.googleapis.com/token",
            "https://www.googleapis.com/drive/v3/files", "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            "https://graph.microsoft.com/v1.0/me", "https://public.am.files.1drv.com/y4m", "https://contoso-my.sharepoint.com/x",
            "https://my.microsoftpersonalcontent.com/x",
        ] {
            XCTAssertTrue(PinnedHosts.allows(URL(string: ok)!), ok)
        }
        for bad in [
            "http://www.googleapis.com/drive/v3", "https://example.org/", "https://googleapis.com.example.org/",
            "https://www.googleapis.com.evil.org/", "https://evilsharepoint.com/", "https://.sharepoint.com/",
            "https://files.1drv.com.example.org/", "https://user:pw@graph.microsoft.com/", "https://graph.microsoft.com:8443/",
            "ftp://graph.microsoft.com/", "file:///etc/passwd", "https://127.0.0.1/",
        ] {
            XCTAssertFalse(PinnedHosts.allows(URL(string: bad)!), bad)
        }
    }

    func testRefusedAddressesAreNeverSent() async throws {
        StubProtocol.reset { _ in .text("should not be asked") }
        let net = StubNet.net()
        for bad in ["https://example.org/", "http://graph.microsoft.com/v1.0/me"] {
            do {
                _ = try await net.data(URLRequest(url: URL(string: bad)!))
                XCTFail("sent \(bad)")
            } catch {
                XCTAssertEqual((error as? CloudError)?.code, .denied)
            }
        }
        // A provider's own list is narrower: Drive code cannot reach Graph.
        let http = CloudHTTP(net: net, allow: [CloudAPI.drive], retry: StubNet.retry())
        do {
            _ = try await http.send(URL(string: "https://graph.microsoft.com/v1.0/me")!)
            XCTFail("sent")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .denied)
        }
        XCTAssertEqual(StubProtocol.requests.count, 0)
    }

    func testARedirectToAnotherHostIsNotFollowed() {
        let net = StubNet.net()
        let task = URLSession(configuration: .ephemeral).dataTask(with: URL(string: "https://graph.microsoft.com/v1.0/x")!)
        let res = HTTPURLResponse(url: URL(string: "https://graph.microsoft.com/v1.0/x")!, statusCode: 302, httpVersion: nil, headerFields: nil)!
        var followed: URLRequest?? = .none
        net.urlSession(URLSession.shared, task: task, willPerformHTTPRedirection: res,
                       newRequest: URLRequest(url: URL(string: "https://example.org/x")!)) { followed = .some($0) }
        XCTAssertEqual(followed, .some(nil))
        var allowed = URLRequest(url: URL(string: "https://a.files.1drv.com/x")!)
        allowed.setValue("Bearer t", forHTTPHeaderField: "Authorization")
        net.urlSession(URLSession.shared, task: task, willPerformHTTPRedirection: res, newRequest: allowed) { followed = .some($0) }
        XCTAssertEqual(followed??.url?.host, "a.files.1drv.com")
        XCTAssertNil(followed??.value(forHTTPHeaderField: "Authorization"))
    }

    /// Fails on any network call in the app or the extension other than the one in CloudNet.swift.
    func testNoOtherNetworkCodeInTheSources() throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: Self.apple.appendingPathComponent("Shared").path) else {
            throw XCTSkip("Sources are not readable from here")
        }
        let forbidden: [String] = [
            "URLSession", "NSURLConnection", "NSURLSession", "CFNetwork", "CFStream", "NWConnection", "NWPathMonitor",
            "import Network", "WKWebView", "SFSafariViewController", "Data(contentsOf: URL(string",
            "String(contentsOf: URL(string", "URLProtocol", "Socket", "Stream(", "NSAllowsArbitraryLoads",
        ]
        var checked = 0
        var hits: [String] = []
        for dir in ["App", "Shared", "Extension"] {
            let root = Self.apple.appendingPathComponent(dir)
            let files = fm.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
            for f in files where f.pathExtension == "swift" {
                checked += 1
                if dir == "Shared" && f.lastPathComponent == "CloudNet.swift" { continue }
                let text = try String(contentsOf: f, encoding: .utf8)
                for (i, line) in text.components(separatedBy: "\n").enumerated() {
                    let code = line.components(separatedBy: "//").first ?? ""
                    for w in forbidden where code.contains(w) {
                        hits.append("\(dir)/\(f.lastPathComponent):\(i + 1): \(w)")
                    }
                }
            }
        }
        XCTAssertGreaterThan(checked, 10)
        XCTAssertEqual(hits, [], "Network code outside PinnedNet")
    }

    /// App Transport Security stays strict: no plist loosens it.
    func testTransportSecurityIsLeftStrict() throws {
        let config = Self.apple.appendingPathComponent("Config")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: config.path) else {
            throw XCTSkip("Config is not readable from here")
        }
        for n in names where n.hasSuffix(".plist") || n.hasSuffix(".entitlements") {
            let text = try String(contentsOf: config.appendingPathComponent(n), encoding: .utf8)
            XCTAssertFalse(text.contains("NSAppTransportSecurity"), n)
            XCTAssertFalse(text.contains("network.server"), n)
        }
    }
}
