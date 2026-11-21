import XCTest

final class GoogleDriveTests: XCTestCase {
    var drive: FakeDrive!
    var secrets: MemorySecrets!
    var kit: CloudSetup!
    var waits: WaitLog!

    override func setUpWithError() throws {
        drive = FakeDrive()
        drive.install()
        secrets = MemorySecrets()
        waits = WaitLog()
        kit = setup(try freshSpace(self), secrets: secrets, retry: StubNet.retry(waits))
        signIn(secrets, .google)
    }

    func testFindsOrMakesTheVisibleFolderOnce() async throws {
        let p = kit.provider(.google)
        let f = try await p.folders()
        XCTAssertEqual(drive.files[f.top]?.name, "Notes App")
        XCTAssertEqual(drive.files[f.top]?.parent, "root")
        XCTAssertEqual(drive.files[f.pages]?.parent, f.top)
        // Asked again, the same folders are found, not made twice.
        let again = try await p.folders()
        XCTAssertEqual(again, f)
        XCTAssertEqual(drive.files.values.filter(\.folder).count, 2)
    }

    func testListFollowsEveryPage() async throws {
        let p = kit.provider(.google)
        let f = try await p.folders()
        drive.pageSize = 2
        for i in 0..<5 { _ = drive.add("p\(i).ink.json", parent: f.pages, data: Data("x".utf8)) }
        let l = try await p.list(f.pages)
        XCTAssertEqual(l.files.map(\.name).sorted(), (0..<5).map { "p\($0).ink.json" })
        XCTAssertEqual(StubProtocol.requests.filter { params($0.url)["pageToken"] != nil }.count, 2)
        XCTAssertEqual(l.cursor, String(l.files.map(\.mtime).max()!))
    }

    func testWaitsOutRateLimitsThenGivesUp() async throws {
        let p = kit.provider(.google)
        drive.throttle = 2
        _ = try await p.folders()
        XCTAssertEqual(waits.all.count, 2)
        drive.throttle = 10
        do {
            _ = try await p.list("x")
            XCTFail("no error")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .throttled)
        }
    }

    func testAnExpiredTokenIsRenewedWithTheRefreshToken() async throws {
        signIn(secrets, .google, access: "old", exp: nowMillis() - 1)
        let p = kit.provider(.google)
        _ = try await p.folders()
        XCTAssertEqual(drive.refreshes, 1)
        let t: Tokens? = secrets.getJSON(Tokens.key(.google))
        XCTAssertEqual(t?.access, "access-2")
        XCTAssertEqual(t?.refresh, "refresh-1")
        XCTAssertEqual(t?.account, "reader@example.org")
    }

    func testATokenRefusedMidwayIsRenewedOnce() async throws {
        // The token looks fresh here but the provider says it ran out.
        drive.validToken = "rotated"
        let p = kit.provider(.google)
        _ = try await p.folders()
        XCTAssertEqual(drive.refreshes, 1)
    }

    func testARefusedRefreshMeansSignInAgain() async throws {
        try secrets.setJSON(Tokens.key(.google), Tokens(access: "old", exp: 0, refresh: "revoked"))
        do {
            _ = try await kit.provider(.google).folders()
            XCTFail("no error")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .expired)
        }
    }

    func testUpdateOfAFileChangedElsewhereIsAConflict() async throws {
        let p = kit.provider(.google)
        let f = try await p.folders()
        let made = try await p.create(f.pages, "a.ink.json", Data("one".utf8))
        drive.files[made.id]?.version += 1
        do {
            _ = try await p.update(made, Data("two".utf8))
            XCTFail("no conflict")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .conflict)
        }
        XCTAssertEqual(drive.files[made.id]?.data, Data("one".utf8))
    }

    func testRemoveAllPutsTheFolderInTheBin() async throws {
        let p = kit.provider(.google)
        let f = try await p.folders()
        _ = try await p.create(f.pages, "a.ink.json", Data("one".utf8))
        try await p.removeAll(f)
        XCTAssertEqual(drive.files[f.top]?.trashed, true)
        XCTAssertTrue(drive.files.values.contains { $0.name == "a.ink.json" })
    }
}

final class CloudFolderTests: XCTestCase {
    var drive: FakeDrive!
    var kit: CloudSetup!

    override func setUpWithError() throws {
        drive = FakeDrive()
        drive.install()
        let secrets = MemorySecrets()
        kit = setup(try freshSpace(self), secrets: secrets)
        signIn(secrets, .google)
    }

    func testWriteReadListThroughNames() async throws {
        let folder = kit.folder(.google)
        try await folder.write("pages/a.ink.json", Data("one".utf8))
        try await folder.write("pages/a.ink.json", Data("two".utf8))
        try await folder.write("pageink.lock.json", Data("{}".utf8))
        same(try await folder.list("pages").map(\.name), ["pages/a.ink.json"])
        same(try await folder.list("").map(\.name), ["pageink.lock.json"])
        same(try await folder.read("pages/a.ink.json"), Data("two".utf8))
        XCTAssertEqual(drive.files.values.filter { $0.name == "a.ink.json" }.count, 1)
        try await folder.remove("pages/a.ink.json")
        same(try await folder.list("pages").count, 0)
    }

    func testTwoFilesWithOneNameShowAsASyncCopy() async throws {
        let folder = kit.folder(.google)
        try await folder.write("pages/a.ink.json", Data("one".utf8))
        let pages = drive.files.values.first { $0.name == "pages" }!.id
        _ = drive.add("a.ink.json", parent: pages, data: Data("other".utf8))
        let names = try await folder.list("pages").map(\.name)
        XCTAssertEqual(names.count, 2)
        XCTAssertTrue(names.contains("pages/a.ink.json"))
        XCTAssertTrue(names.contains { $0.hasPrefix("pages/a (copy ") })
    }

    func testFileDeletedElsewhereIsWrittenAnew() async throws {
        let folder = kit.folder(.google)
        try await folder.write("pages/a.ink.json", Data("one".utf8))
        let id = drive.files.values.first { $0.name == "a.ink.json" }!.id
        drive.files[id]?.trashed = true
        try await folder.write("pages/a.ink.json", Data("two".utf8))
        let live = drive.files.values.filter { $0.name == "a.ink.json" && !$0.trashed }
        XCTAssertEqual(live.count, 1)
        XCTAssertEqual(live.first?.data, Data("two".utf8))
    }

    func testANewProcessRebuildsTheNameListFromTheCache() async throws {
        let space = kit.space
        try await kit.folder(.google).write("pages/a.ink.json", Data("one".utf8))
        // Another device adds a file.
        let pages = drive.files.values.first { $0.name == "pages" }!.id
        _ = drive.add("b.ink.json", parent: pages, data: Data("b".utf8))
        // A new handler process starts from the cache and asks only for changes.
        let before = StubProtocol.requests.count
        let names = try await kit.folder(.google).list("pages").map(\.name)
        XCTAssertEqual(names, ["pages/a.ink.json", "pages/b.ink.json"])
        let asked = StubProtocol.requests.dropFirst(before).compactMap { params($0.url)["q"] }
        XCTAssertTrue(asked.allSatisfy { $0.contains("modifiedTime >") }, "\(asked)")
        // A lost cache is rebuilt by listing in full.
        space.cloudCache(.google).set(nil)
        same(try await kit.folder(.google).list("pages").map(\.name), ["pages/a.ink.json", "pages/b.ink.json"])
    }

    func testAFolderRemovedByTheReaderIsMadeAgain() async throws {
        try await kit.folder(.google).write("pages/a.ink.json", Data("one".utf8))
        let pages = drive.files.values.first { $0.name == "pages" }!.id
        drive.files[pages] = nil
        kit.space.cloudCache(.google).set({ var c = kit.space.cloudCache(.google).get()!; c.cursor = nil; return c }())
        same(try await kit.folder(.google).list("pages").count, 0)
    }
}

final class OneDriveTests: XCTestCase {
    var secrets: MemorySecrets!
    var kit: CloudSetup!
    let G = "https://graph.microsoft.com/v1.0"

    override func setUpWithError() throws {
        secrets = MemorySecrets()
        kit = setup(try freshSpace(self), secrets: secrets)
        signIn(secrets, .onedrive)
    }

    func item(_ id: String, _ name: String, etag: String = "\"e1\"", file: Bool = true) -> [String: Any] {
        var o: [String: Any] = ["id": id, "name": name, "eTag": etag, "lastModifiedDateTime": "2026-11-17T10:00:00Z", "size": 3]
        o[file ? "file" : "folder"] = [String: Any]()
        return o
    }

    func testChildrenFollowNextLinksAndStayOnGraph() async throws {
        StubProtocol.reset { [G] s in
            if params(s.url)["$skiptoken"] == "2" { return .json(["value": [self.item("c", "c.ink.json")]]) }
            if s.url.path.hasSuffix("/delta") { return .json(["value": [], "@odata.deltaLink": "\(G)/me/drive/items/P/delta?token=t1"]) }
            return .json(["value": [self.item("a", "a.ink.json"), self.item("f", "sub", file: false)],
                          "@odata.nextLink": "\(G)/me/drive/items/P/children?$skiptoken=2"])
        }
        let l = try await kit.provider(.onedrive).list("P")
        XCTAssertEqual(l.files.map(\.name), ["a.ink.json", "c.ink.json"])
        XCTAssertEqual(l.cursor, "\(G)/me/drive/items/P/delta?token=t1")

        // A next link that leaves Graph is refused before it is sent.
        StubProtocol.reset { _ in .json(["value": [], "@odata.nextLink": "https://example.org/steal"]) }
        do {
            _ = try await kit.provider(.onedrive).list("P")
            XCTFail("no error")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .denied)
        }
        XCTAssertFalse(StubProtocol.requests.contains { $0.url.host == "example.org" })
    }

    func testUpdateSendsTheETagAndAMismatchIsAConflict() async throws {
        StubProtocol.reset { s in
            s.headers["If-Match"] == "\"e1\"" ? .json(self.item("a", "a.ink.json", etag: "\"e2\"")) : .json(["error": "pre"], status: 412)
        }
        let p = kit.provider(.onedrive)
        let f = RemoteFile(id: "a", name: "a.ink.json", mtime: 0, size: 0, version: "\"e1\"")
        let out = try await p.update(f, Data("x".utf8))
        XCTAssertEqual(out.version, "\"e2\"")
        do {
            _ = try await p.update(RemoteFile(id: "a", name: "a.ink.json", mtime: 0, size: 0, version: "\"old\""), Data("x".utf8))
            XCTFail("no conflict")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .conflict)
        }
    }

    func testANewNameFailsWhenTaken() async throws {
        StubProtocol.reset { s in
            XCTAssertTrue(s.url.absoluteString.contains("conflictBehavior=fail"))
            return .json(["error": ["code": "nameAlreadyExists"]], status: 409)
        }
        do {
            _ = try await kit.provider(.onedrive).create("P", "a.ink.json", Data("x".utf8))
            XCTFail("no conflict")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .conflict)
        }
    }

    func testDeltaReportsChangesAndRemovals() async throws {
        StubProtocol.reset { [G] _ in
            .json(["value": [self.item("P", "pages", file: false), self.item("a", "a.ink.json"),
                             ["id": "b", "name": "b.ink.json", "deleted": [String: Any]()]],
                   "@odata.deltaLink": "\(G)/me/drive/items/P/delta?token=t2"])
        }
        let c = try await kit.provider(.onedrive).changes("P", "\(G)/me/drive/items/P/delta?token=t1")
        XCTAssertEqual(c.files.map(\.id), ["a"])
        XCTAssertEqual(c.gone, ["b"])
        XCTAssertEqual(c.cursor, "\(G)/me/drive/items/P/delta?token=t2")
    }

    func testDownloadFollowsTheFileHostWithoutTheToken() async throws {
        StubProtocol.reset { s in
            if s.url.host == "graph.microsoft.com" { return .init(redirect: URL(string: "https://public.am.files.1drv.com/y4m/a?x=1")!) }
            return .text("note text")
        }
        let d = try await kit.provider(.onedrive).download(RemoteFile(id: "a", name: "a", mtime: 0, size: 0, version: ""))
        XCTAssertEqual(String(decoding: d, as: UTF8.self), "note text")
        let file = try XCTUnwrap(StubProtocol.requests.last)
        XCTAssertEqual(file.url.host, "public.am.files.1drv.com")
        XCTAssertNil(file.headers["Authorization"])
    }

    func testRefreshKeepsTheNewRefreshToken() async throws {
        try secrets.setJSON(Tokens.key(.onedrive), Tokens(access: "old", exp: 0, refresh: "r1", account: "a@b.c"))
        StubProtocol.reset { s in
            if s.url.host == "login.microsoftonline.com" {
                let f = formOf(s.body)
                XCTAssertEqual(f["grant_type"], "refresh_token")
                XCTAssertEqual(f["scope"], Scopes.microsoft)
                XCTAssertNil(f["client_secret"])
                return .json(["access_token": "new", "refresh_token": "r2", "expires_in": 3600])
            }
            return .json(["id": "top"])
        }
        _ = try await kit.session(.onedrive).get()
        let t: Tokens? = secrets.getJSON(Tokens.key(.onedrive))
        XCTAssertEqual(t?.refresh, "r2")
        XCTAssertEqual(t?.access, "new")
        XCTAssertEqual(t?.account, "a@b.c")
    }

    func testFullStorageIsReported() async throws {
        StubProtocol.reset { _ in .json(["error": ["code": "quotaLimitReached"]], status: 507) }
        do {
            _ = try await kit.provider(.onedrive).create("P", "a.ink.json", Data("x".utf8))
            XCTFail("no error")
        } catch {
            XCTAssertEqual((error as? CloudError)?.code, .full)
        }
    }
}

final class SignInTests: XCTestCase {
    func testRedirectsPerProvider() {
        let ids = ClientIds(google: "1234-abc.apps.googleusercontent.com", microsoft: "m-id")
        XCTAssertEqual(Redirects.of(.google, ids: ids, bundleId: "org.example.x"),
                       Redirect(uri: "com.googleusercontent.apps.1234-abc:/oauthredirect", scheme: "com.googleusercontent.apps.1234-abc"))
        XCTAssertEqual(Redirects.of(.onedrive, ids: ids, bundleId: "org.example.x"),
                       Redirect(uri: "msauth.org.example.x://auth", scheme: "msauth.org.example.x"))
        XCTAssertNil(Redirects.of(.google, ids: .none, bundleId: "org.example.x"))
    }

    func testStartAndFinishWithPKCE() async throws {
        let ids = ClientIds(google: "1234-abc.apps.googleusercontent.com", microsoft: "m-id")
        let o = OAuth(ids: ids, bundleId: "org.example.x", net: StubNet.net(), retry: StubNet.retry())
        let s = try o.start(.google)
        let q = params(s.url)
        XCTAssertEqual(s.url.host, "accounts.google.com")
        XCTAssertEqual(q["response_type"], "code")
        XCTAssertEqual(q["code_challenge_method"], "S256")
        XCTAssertEqual(q["code_challenge"], PKCE.challenge(s.verifier))
        XCTAssertEqual(q["scope"], Scopes.google)
        XCTAssertNil(q["client_secret"])
        StubProtocol.reset { r in
            let f = formOf(r.body)
            XCTAssertEqual(f["code_verifier"], s.verifier)
            XCTAssertEqual(f["code"], "c1")
            XCTAssertNil(f["client_secret"])
            return .json(["access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": Scopes.google])
        }
        let back = URL(string: "\(s.redirect.uri)?state=\(s.state)&code=c1")!
        let t = try await o.finish(s, returned: back)
        XCTAssertEqual(t.refresh, "r")
        // A wrong state is refused, and so is an error.
        do {
            _ = try await o.finish(s, returned: URL(string: "\(s.redirect.uri)?state=x&code=c1")!)
            XCTFail("no error")
        } catch { XCTAssertEqual((error as? CloudError)?.code, .denied) }
        do {
            _ = try await o.finish(s, returned: URL(string: "\(s.redirect.uri)?error=access_denied&state=\(s.state)")!)
            XCTFail("no error")
        } catch { XCTAssertEqual((error as? CloudError)?.code, .denied) }
    }

    /// The only scopes ever asked for. Adding any other scope, such as openid, profile or email,
    /// fails here. The extension asks for the same ones, read from its source.
    func testOnlyTheDocumentedScopesAreAskedFor() async throws {
        let google: Set<String> = ["https://www.googleapis.com/auth/drive.file"]
        let microsoft: Set<String> = ["Files.ReadWrite.AppFolder", "offline_access"]
        func set(_ s: String?) -> Set<String> { Set((s ?? "").split(separator: " ").map(String.init)) }
        XCTAssertEqual(set(Scopes.google), google)
        XCTAssertEqual(set(Scopes.microsoft), microsoft)

        let ids = ClientIds(google: "1234-abc.apps.googleusercontent.com", microsoft: "m-id")
        let o = OAuth(ids: ids, bundleId: "org.example.x", net: StubNet.net(), retry: StubNet.retry())
        XCTAssertEqual(set(params(try o.start(.google).url)["scope"]), google)
        let s = try o.start(.onedrive)
        XCTAssertEqual(set(params(s.url)["scope"]), microsoft)
        StubProtocol.reset { _ in .json(["access_token": "a", "refresh_token": "r", "expires_in": 3600]) }
        let t = try await o.finish(s, returned: URL(string: "\(s.redirect.uri)?state=\(s.state)&code=c1")!)
        XCTAssertNil(t.account)
        _ = try await o.refresh(.onedrive, t)
        let asked = StubProtocol.requests.map { formOf($0.body)["scope"] }
        XCTAssertEqual(asked.count, 2)
        for a in asked { XCTAssertEqual(set(a), microsoft) }

        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("packages/extension/src/cloud")
        let od = try String(contentsOf: here.appendingPathComponent("onedrive.ts"), encoding: .utf8)
        let gd = try String(contentsOf: here.appendingPathComponent("google.ts"), encoding: .utf8)
        XCTAssertTrue(od.contains("export const MS_SCOPES = '\(Scopes.microsoft)';"))
        XCTAssertTrue(gd.contains("export const DRIVE_SCOPE = '\(Scopes.google)';"))
    }

    func testClientIdsLoadEmptyFromTheCommittedFile() throws {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let d = try Data(contentsOf: here.appendingPathComponent("Shared/cloud-ids.json"))
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: d) as? [String: Any])
        XCTAssertEqual(o["google"] as? String, "", "The committed file must keep empty ids")
        XCTAssertEqual(o["microsoft"] as? String, "", "The committed file must keep empty ids")
    }
}
