import XCTest

/// The handler's cloud requests, with a Google Drive in memory standing in for the provider.
final class CloudHandlerTests: XCTestCase {
    var drive: FakeDrive!
    var space: SharedSpace!
    var secrets: MemorySecrets!
    var kit: CloudSetup!
    var opened: [URL] = []

    override func setUpWithError() throws {
        drive = FakeDrive()
        drive.install()
        space = try freshSpace(self)
        secrets = MemorySecrets()
        kit = setup(space, secrets: secrets)
        opened = []
    }

    func handler(ids: ClientIds? = nil, folderName: String = "Notes") -> NativeHandler {
        let k = ids.map { setup(space, secrets: secrets, ids: $0) } ?? kit!
        let routes = CloudRoutes(kit: k, appURL: { URL(string: "org.example.test://connect?place=\($0.rawValue)") },
                                 openApp: { self.opened.append($0) })
        let store = space.store()
        return NativeHandler(target: { NativeTarget(store: store, name: folderName) }, cloud: routes,
                             forgetFolder: { self.space.folderLink = nil })
    }

    func call(_ h: NativeHandler, _ m: [String: Any]) async -> [String: Any] { await h.handleAsync(m) }

    func connected() async -> NativeHandler {
        signIn(secrets, .google)
        let h = handler()
        let r = await call(h, ["v": 1, "op": "connect", "place": "google"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        return h
    }

    func pageNames() -> [String] {
        guard let pages = drive.files.values.first(where: { $0.name == "pages" && $0.folder })?.id else { return [] }
        return drive.pageNames(pages)
    }

    func testNotSetUpWithoutAClientId() async {
        let h = handler(ids: ClientIds.none)
        let r = await call(h, ["v": 1, "op": "connect", "place": "onedrive"])
        XCTAssertEqual(r["error"] as? String, "not-set-up")
        same(await call(h, ["v": 1, "op": "connect", "place": "dropbox"])["error"] as? String, "bad-request")
    }

    func testConnectWithoutTokensAsksTheAppAndAnswersPending() async {
        let h = handler()
        let r = await call(h, ["v": 1, "op": "connect", "place": "google"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["pending"] as? Bool, true)
        let request = try? XCTUnwrap(space.pendingConnect?.request)
        XCTAssertEqual(request?.count, 32)
        let link = "org.example.test://connect?place=google&request=\(request ?? "")"
        XCTAssertEqual(r["open"] as? String, link)
        XCTAssertEqual(opened.map(\.absoluteString), [link])
        XCTAssertEqual(space.pendingConnect?.provider, .google)
        XCTAssertNil(space.place)
        XCTAssertEqual(StubProtocol.requests.count, 0)
        // The app takes only that link.
        XCTAssertEqual(PendingConnect.match(URL(string: link)!, pending: space.pendingConnect), .google)
    }

    func testOnlyALinkCarryingTheExtensionsOwnRequestCounts() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let pending = PendingConnect(provider: .google, at: now, request: "abc123")
        let ok = URL(string: "org.example.test://connect?place=google&request=abc123")!
        XCTAssertEqual(PendingConnect.match(ok, pending: pending, now: now.addingTimeInterval(60)), .google)
        for bad in [
            "org.example.test://connect?place=google",
            "org.example.test://connect?place=google&request=abc124",
            "org.example.test://connect?place=onedrive&request=abc123",
            "org.example.test://other?place=google&request=abc123",
        ] {
            XCTAssertNil(PendingConnect.match(URL(string: bad)!, pending: pending, now: now), bad)
        }
        XCTAssertNil(PendingConnect.match(ok, pending: nil, now: now), "No request was made")
        XCTAssertNil(PendingConnect.match(ok, pending: PendingConnect(provider: .google, at: now), now: now), "A request without an id")
        XCTAssertNil(PendingConnect.match(ok, pending: pending, now: now.addingTimeInterval(31 * 60)), "Too old")
    }

    func testSwitchingCloudsWhileChangesWaitIsRefusedAndKeepsThem() async throws {
        let h = await connected()
        drive.offline = true
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "waiting"])
        drive.offline = false
        XCTAssertEqual(WriteQueue(space: space).count, 1)
        signIn(secrets, .onedrive)
        let r = await call(h, ["v": 1, "op": "connect", "place": "onedrive"])
        XCTAssertEqual(r["error"] as? String, "conflict")
        XCTAssertEqual(space.place?.provider, .google)
        XCTAssertEqual(WriteQueue(space: space).count, 1, "The waiting change is kept")
        XCTAssertNotNil(kit.signedIn(.google))
    }

    func testConnectWithTokensMakesTheCloudThePlace() async {
        let h = await connected()
        let s = await call(h, ["v": 1, "op": "status"])
        XCTAssertEqual(s["place"] as? String, "google")
        XCTAssertEqual(s["folder"] as? String, "Google Drive")
        XCTAssertEqual(s["account"] as? String, "reader@example.org")
    }

    func testTheAccountNameStaysInTheKeychainOnly() async throws {
        let h = await connected()
        let s = await call(h, ["v": 1, "op": "status"])
        XCTAssertEqual(s["account"] as? String, "reader@example.org")
        // No file in the App Group holds it: the extension's process and its pages read those.
        let all = FileManager.default.enumerator(at: space.root, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        for u in all {
            guard let d = try? Data(contentsOf: u) else { continue }
            XCTAssertFalse(String(decoding: d, as: UTF8.self).contains("reader@example.org"), u.lastPathComponent)
        }
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": false])["ok"] as? Bool, true)
        XCTAssertNil(kit.signedIn(.google))
        let after = await call(h, ["v": 1, "op": "status"])
        XCTAssertNil(after["account"])
    }

    func testAnAccountNameOlderBuildsKeptInThePlaceIsRemoved() throws {
        try FileManager.default.createDirectory(at: space.stateDir, withIntermediateDirectories: true)
        let u = space.stateDir.appendingPathComponent("place.json")
        try Data(#"{"provider":"google","account":"reader@example.org"}"#.utf8).write(to: u)
        _ = setup(space, secrets: secrets)
        XCTAssertFalse(String(decoding: try Data(contentsOf: u), as: UTF8.self).contains("account"))
        XCTAssertEqual(space.place?.provider, .google)
    }

    func testFileRequestsGoToTheCloudAndTheContainerKeepsACopy() async throws {
        let h = await connected()
        let text = "{\n  \"v\": 1\n}\n"
        same(await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": text])["ok"] as? Bool, true)
        XCTAssertEqual(pageNames(), ["a.ink.json"])
        XCTAssertEqual(try space.store().read("pages/a.ink.json"), Data(text.utf8))
        let l = await call(h, ["v": 1, "op": "list", "dir": "pages"])
        XCTAssertEqual((l["files"] as? [[String: Any]])?.map { $0["name"] as? String }, ["pages/a.ink.json"])
        same(await call(h, ["v": 1, "op": "read", "name": "pages/a.ink.json"])["text"] as? String, text)
        same(await call(h, ["v": 1, "op": "read", "name": "pages/zz.ink.json"])["error"] as? String, "not-found")
        same(await call(h, ["v": 1, "op": "remove", "name": "pages/a.ink.json"])["ok"] as? Bool, true)
        XCTAssertEqual(pageNames(), [])
        // Bad names are refused before anything is sent.
        let before = StubProtocol.requests.count
        same(await call(h, ["v": 1, "op": "read", "name": "../x"])["error"] as? String, "bad-name")
        XCTAssertEqual(StubProtocol.requests.count, before)
    }

    func testAnotherDevicesWriteIsAConflict() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "one"])
        let id = drive.files.values.first { $0.name == "a.ink.json" }!.id
        drive.files[id]?.version += 1
        drive.files[id]?.data = Data("theirs".utf8)
        let r = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "mine"])
        XCTAssertEqual(r["error"] as? String, "conflict")
        XCTAssertEqual(drive.files[id]?.data, Data("theirs".utf8))
        XCTAssertEqual(WriteQueue(space: space).count, 0)
    }

    func testOfflineWritesWaitInTheQueueAndGoUpOnTheNextList() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "list", "dir": "pages"])
        drive.offline = true
        let r = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "offline"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["queued"] as? Bool, true)
        XCTAssertEqual(try space.store().read("pages/a.ink.json"), Data("offline".utf8), "The container keeps every note")
        XCTAssertEqual(WriteQueue(space: space).count, 1)
        same(await call(h, ["v": 1, "op": "list", "dir": "pages"])["error"] as? String, "offline")
        drive.offline = false
        let l = await call(h, ["v": 1, "op": "list", "dir": "pages"])
        XCTAssertEqual((l["files"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(WriteQueue(space: space).count, 0)
        XCTAssertEqual(drive.files.values.first { $0.name == "a.ink.json" }?.data, Data("offline".utf8))
    }

    func testTheAppFlushesTheQueueAndKeepsBothWhenTheCloudChangedMeanwhile() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "one"])
        drive.offline = true
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "mine, offline"])
        drive.offline = false
        // Meanwhile another device wrote the same file.
        let id = drive.files.values.first { $0.name == "a.ink.json" }!.id
        drive.files[id]?.version += 1
        drive.files[id]?.data = Data("theirs".utf8)
        drive.files[id]?.mtime = drive.tick()
        let st = await CloudSync(kit: kit).run()
        XCTAssertNil(st.problem)
        XCTAssertEqual(st.waiting, 0)
        XCTAssertEqual(drive.files[id]?.data, Data("theirs".utf8), "Another device's write is never replaced unseen")
        let names = pageNames()
        XCTAssertEqual(names.count, 2)
        XCTAssertTrue(names.contains { $0.hasPrefix("a (conflicted copy ") }, "\(names)")
        // The app copied the cloud's files into the container for the library.
        XCTAssertEqual(try space.store().read("pages/a.ink.json"), Data("theirs".utf8))
    }

    func testTwoCopiesMadeInTheSameMinuteKeepDifferentNames() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "one"])
        let id = drive.files.values.first { $0.name == "a.ink.json" }!.id
        for (i, text) in ["first", "second"].enumerated() {
            drive.offline = true
            _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": text])
            drive.offline = false
            drive.files[id]?.version += 1
            drive.files[id]?.data = Data("theirs \(i)".utf8)
            drive.files[id]?.mtime = drive.tick()
            // The same moment both times, as two changes made within one minute.
            var idx = space.queueIndex
            for k in idx.keys { idx[k]?.at = Date(timeIntervalSince1970: 1_800_000_000) }
            space.queueIndex = idx
            _ = await CloudSync(kit: kit).run()
        }
        let copies = drive.files.values.filter { $0.name.hasPrefix("a (conflicted copy ") }
        XCTAssertEqual(copies.count, 2, "\(pageNames())")
        XCTAssertEqual(Set(copies.map(\.data)), [Data("first".utf8), Data("second".utf8)])
    }

    func testExpiredSignInIsReportedAndTheWriteIsKept() async throws {
        let h = await connected()
        try secrets.setJSON(Tokens.key(.google), Tokens(access: "x", exp: 0, refresh: "revoked"))
        let r = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "kept"])
        XCTAssertEqual(r["error"] as? String, "expired")
        XCTAssertEqual(try space.store().read("pages/a.ink.json"), Data("kept".utf8))
        XCTAssertEqual(WriteQueue(space: space).count, 1)
    }

    func testDisconnectKeepsTheFilesAndGivesTheTokenBack() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "one"])
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": false])["ok"] as? Bool, true)
        XCTAssertEqual(drive.revoked, ["refresh-1"])
        XCTAssertNil(secrets.get(Tokens.key(.google)))
        XCTAssertNil(space.place)
        XCTAssertEqual(pageNames(), ["a.ink.json"])
        // Back to the container on this device.
        let s = await call(h, ["v": 1, "op": "status"])
        XCTAssertEqual(s["place"] as? String, "folder")
        XCTAssertEqual(try space.store().read("pages/a.ink.json"), Data("one".utf8))
    }

    func testDisconnectWithRemoveFilesUsesTheBinAndKeepsSignInOnFailure() async throws {
        let h = await connected()
        _ = await call(h, ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "one"])
        drive.offline = true
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": true])["error"] as? String, "offline")
        XCTAssertNotNil(secrets.get(Tokens.key(.google)), "The sign-in stays so the reader can try again")
        drive.offline = false
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": true])["ok"] as? Bool, true)
        XCTAssertEqual(drive.files.values.first { $0.name == "Notes App" }?.trashed, true)
        XCTAssertNil(secrets.get(Tokens.key(.google)))
    }

    func testDisconnectOfAFolderForgetsIt() async {
        space.folderLink = FolderLink(bookmark: Data([1]), name: "F", pickedAt: Date())
        let h = handler()
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": false])["ok"] as? Bool, true)
        XCTAssertNil(space.folderLink)
        same(await call(h, ["v": 1, "op": "disconnect", "removeFiles": "yes"])["error"] as? String, "bad-request")
    }

    /// The privacy promise: nothing is sent before the reader connects a cloud.
    func testNoRequestBeforeConnect() async {
        let before = PinnedNet.sent
        let h = handler()
        for m: [String: Any] in [
            ["v": 1, "op": "status"],
            ["v": 1, "op": "list", "dir": "pages"],
            ["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "x"],
            ["v": 1, "op": "read", "name": "pages/a.ink.json"],
            ["v": 1, "op": "list", "dir": ""],
            ["v": 1, "op": "remove", "name": "pages/a.ink.json"],
            ["v": 1, "op": "access", "all": true],
        ] {
            let r = await call(h, m)
            XCTAssertEqual(r["ok"] as? Bool, true, "\(m)")
        }
        // A sync in the app with no cloud does nothing either.
        _ = await CloudSync(kit: kit).run()
        XCTAssertEqual(StubProtocol.requests.count, 0)
        XCTAssertEqual(PinnedNet.sent, before)
    }

    func testCopyMyNotesToTheNewPlace() async throws {
        try space.store().write("pages/old.ink.json", Data("old".utf8))
        try space.store().write("pages/both.ink.json", Data("mine".utf8))
        let h = await connected()
        _ = h
        // The cloud already has a page with that name, with other text.
        let pagesId = try await kit.folder(.google).ensure().pages
        _ = drive.add("both.ink.json", parent: pagesId, data: Data("theirs".utf8))
        space.cloudCache(.google).set(nil)
        let n = try await CloudSync(kit: kit).copyAll()
        XCTAssertEqual(n, 2)
        let names = pageNames()
        XCTAssertTrue(names.contains("old.ink.json"))
        XCTAssertTrue(names.contains { $0.hasPrefix("both (conflicted copy ") })
        XCTAssertEqual(drive.files.values.first { $0.name == "both.ink.json" }?.data, Data("theirs".utf8))
    }
}
