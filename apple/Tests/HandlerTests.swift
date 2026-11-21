import XCTest

final class HandlerTests: XCTestCase {
    var root: URL!
    var handler: NativeHandler!

    override func setUpWithError() throws {
        root = try tempDir(self)
        let store = DirectoryStore(root: root, coordinated: false)
        handler = NativeHandler { NativeTarget(store: store, name: "Notes") }
    }

    private func call(_ m: [String: Any]) -> [String: Any] { handler.handle(m) }
    private func ok(_ r: [String: Any]) -> Bool { r["ok"] as? Bool == true }
    private func err(_ r: [String: Any]) -> String? { r["ok"] as? Bool == false ? r["error"] as? String : nil }

    func testStatusNamesTheFolder() {
        let r = call(["v": 1, "op": "status"])
        XCTAssertTrue(ok(r))
        XCTAssertEqual(r["folder"] as? String, "Notes")
    }

    func testStatusWithoutStoreIsNull() {
        let h = NativeHandler { nil }
        let r = h.handle(["v": 1, "op": "status"])
        XCTAssertTrue(r["ok"] as? Bool == true)
        XCTAssertTrue(r["folder"] is NSNull)
        XCTAssertEqual(h.handle(["v": 1, "op": "list", "dir": "pages"])["error"] as? String, "no-folder")
        XCTAssertEqual(h.handle(["v": 1, "op": "read", "name": "pages/a.ink.json"])["error"] as? String, "no-folder")
    }

    func testAccessIsKeptWithoutAFolder() {
        var seen: [Bool] = []
        let h = NativeHandler(target: { nil }, onAccess: { seen.append($0) })
        XCTAssertTrue(h.handle(["v": 1, "op": "access", "all": false])["ok"] as? Bool == true)
        XCTAssertTrue(h.handle(["v": 1, "op": "access", "all": true])["ok"] as? Bool == true)
        XCTAssertEqual(seen, [false, true])
        // A number or a missing value is not a yes or no.
        XCTAssertEqual(h.handle(["v": 1, "op": "access", "all": 1])["error"] as? String, "bad-request")
        XCTAssertEqual(h.handle(["v": 1, "op": "access"])["error"] as? String, "bad-request")
        XCTAssertEqual(seen.count, 2)
    }

    func testSiteAccessIsKeptInTheSharedSpace() throws {
        let space = SharedSpace(root: try tempDir(self))
        XCTAssertNil(space.siteAccess)
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        space.siteAccess = SiteAccess(all: true, at: at)
        XCTAssertEqual(SharedSpace(root: space.root).siteAccess, SiteAccess(all: true, at: at))
    }

    func testWriteReadListRemove() throws {
        let text = "{\n  \"v\": 1, \"note\": \"é ✓\"\n}\n"
        XCTAssertTrue(ok(call(["v": 1, "op": "write", "name": "pages/3k9x2a.ink.json", "text": text])))
        // The folder was created and the file holds exactly the text.
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("pages/3k9x2a.ink.json"), encoding: .utf8), text)

        let read = call(["v": 1, "op": "read", "name": "pages/3k9x2a.ink.json"])
        XCTAssertEqual(read["text"] as? String, text)

        let list = call(["v": 1, "op": "list", "dir": "pages"])
        let files = try XCTUnwrap(list["files"] as? [[String: Any]])
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0]["name"] as? String, "pages/3k9x2a.ink.json")
        XCTAssertEqual((files[0]["size"] as? NSNumber)?.intValue, text.utf8.count)
        let mtime = try XCTUnwrap((files[0]["mtime"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(mtime, Date().timeIntervalSince1970 * 1000, accuracy: 60_000)

        XCTAssertTrue(ok(call(["v": 1, "op": "remove", "name": "pages/3k9x2a.ink.json"])))
        XCTAssertEqual(err(call(["v": 1, "op": "read", "name": "pages/3k9x2a.ink.json"])), "not-found")
        XCTAssertEqual(err(call(["v": 1, "op": "remove", "name": "pages/3k9x2a.ink.json"])), "not-found")
    }

    func testWriteReplacesWholeFileAndLeavesNoTemporaryFiles() throws {
        _ = call(["v": 1, "op": "write", "name": "pages/a.ink.json", "text": String(repeating: "x", count: 1000)])
        _ = call(["v": 1, "op": "write", "name": "pages/a.ink.json", "text": "short"])
        XCTAssertEqual(call(["v": 1, "op": "read", "name": "pages/a.ink.json"])["text"] as? String, "short")
        let names = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("pages").path)
        XCTAssertEqual(names, ["a.ink.json"])
    }

    func testListOfMissingDirIsEmpty() {
        let r = call(["v": 1, "op": "list", "dir": "pages"])
        XCTAssertTrue(ok(r))
        XCTAssertEqual((r["files"] as? [Any])?.count, 0)
    }

    func testListSkipsFoldersAndHiddenFilesAndKeepsConflictCopies() throws {
        let pages = root.appendingPathComponent("pages")
        try FileManager.default.createDirectory(at: pages.appendingPathComponent("sub"), withIntermediateDirectories: true)
        try Data("a".utf8).write(to: pages.appendingPathComponent("a.ink.json"))
        try Data("b".utf8).write(to: pages.appendingPathComponent("a (1).ink.json"))
        try Data("c".utf8).write(to: pages.appendingPathComponent(".DS_Store"))
        let files = call(["v": 1, "op": "list", "dir": "pages"])["files"] as? [[String: Any]] ?? []
        XCTAssertEqual(files.compactMap { $0["name"] as? String }, ["pages/a (1).ink.json", "pages/a.ink.json"])
    }

    func testTraversalAndBadNamesAreRefused() throws {
        // A file outside the store that must stay out of reach.
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside-\(UUID().uuidString).txt")
        try Data("secret".utf8).write(to: outside)
        addTeardownBlock { try? FileManager.default.removeItem(at: outside) }
        let bad: [String] = [
            "../\(outside.lastPathComponent)", "pages/../../x", "/etc/passwd", "pages/..", "..",
            "pages//a.ink.json", "pages/./a.ink.json", "pages\\..\\x", "", ".hidden", "pages/.a.tmp",
            "pages/a\u{0}b", "pages/a\nb", String(repeating: "a", count: 600),
        ]
        for name in bad {
            XCTAssertEqual(err(call(["v": 1, "op": "read", "name": name])), "bad-name", name)
            XCTAssertEqual(err(call(["v": 1, "op": "write", "name": name, "text": "x"])), "bad-name", name)
            XCTAssertEqual(err(call(["v": 1, "op": "remove", "name": name])), "bad-name", name)
        }
        for dir in ["..", "../", "/", "/tmp", "pages/..", "a/../.."] {
            XCTAssertEqual(err(call(["v": 1, "op": "list", "dir": dir])), "bad-name", dir)
        }
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "secret")
    }

    func testSymlinkOutOfTheStoreIsRefused() throws {
        let outside = try tempDir(self)
        try Data("secret".utf8).write(to: outside.appendingPathComponent("s.ink.json"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("pages"), withDestinationURL: outside)
        XCTAssertEqual(err(call(["v": 1, "op": "read", "name": "pages/s.ink.json"])), "bad-name")
        XCTAssertEqual(err(call(["v": 1, "op": "write", "name": "pages/t.ink.json", "text": "x"])), "bad-name")
        XCTAssertEqual(err(call(["v": 1, "op": "list", "dir": "pages"])), "bad-name")
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("t.ink.json").path))
    }

    func testBadInput() {
        XCTAssertEqual(handler.handle(nil)["error"] as? String, "bad-request")
        XCTAssertEqual(handler.handle("status")["error"] as? String, "bad-request")
        XCTAssertEqual(handler.handle([1, 2])["error"] as? String, "bad-request")
        XCTAssertEqual(err(call(["op": "status"])), "unsupported-version")
        XCTAssertEqual(err(call(["v": 2, "op": "status"])), "unsupported-version")
        XCTAssertEqual(err(call(["v": "1", "op": "status"])), "unsupported-version")
        XCTAssertEqual(err(call(["v": true, "op": "status"])), "unsupported-version")
        XCTAssertEqual(err(call(["v": 1.5, "op": "status"])), "unsupported-version")
        XCTAssertEqual(err(call(["v": 1])), "bad-request")
        XCTAssertEqual(err(call(["v": 1, "op": "format"])), "unknown-op")
        XCTAssertEqual(err(call(["v": 1, "op": "read"])), "bad-request")
        XCTAssertEqual(err(call(["v": 1, "op": "read", "name": 7])), "bad-request")
        XCTAssertEqual(err(call(["v": 1, "op": "list"])), "bad-request")
        XCTAssertEqual(err(call(["v": 1, "op": "write", "name": "pages/a.ink.json"])), "bad-request")
        XCTAssertEqual(err(call(["v": 1, "op": "write", "name": "pages/a.ink.json", "text": 5])), "bad-request")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("pages").path))
    }

    func testVersionAsFloatOneIsAccepted() {
        // JSON numbers may arrive as doubles.
        XCTAssertTrue(ok(call(["v": NSNumber(value: 1.0), "op": "status"])))
    }

    func testTooLargeWriteIsRefused() {
        let big = String(repeating: "x", count: NativeHandler.maxTextBytes + 1)
        XCTAssertEqual(err(call(["v": 1, "op": "write", "name": "pages/a.ink.json", "text": big])), "too-large")
    }

    func testReadOfNonUTF8File() throws {
        let pages = root.appendingPathComponent("pages")
        try FileManager.default.createDirectory(at: pages, withIntermediateDirectories: true)
        try Data([0xFF, 0xFE, 0x00]).write(to: pages.appendingPathComponent("b.ink.json"))
        XCTAssertEqual(err(call(["v": 1, "op": "read", "name": "pages/b.ink.json"])), "not-utf8")
    }

    func testICloudPlaceholderIsListedUnderItsRealName() throws {
        let pages = root.appendingPathComponent("pages")
        try FileManager.default.createDirectory(at: pages, withIntermediateDirectories: true)
        try Data().write(to: pages.appendingPathComponent(".abc.ink.json.icloud"))
        let store = DirectoryStore(root: root, coordinated: false)
        let list = try store.list("pages")
        XCTAssertEqual(list.map(\.name), ["pages/abc.ink.json"])
        XCTAssertTrue(list[0].placeholder)
    }

    func testExtensionTargetFallsBackToContainer() throws {
        let space = SharedSpace(root: root)
        // No folder picked: the container, under the default name.
        let t1 = try XCTUnwrap(NativeTarget.forExtension(space: space, defaultName: "App Name"))
        XCTAssertEqual(t1.name, "App Name")
        XCTAssertEqual(t1.store.root, space.storeRoot.standardizedFileURL)
        XCTAssertNil(space.extensionAccess)

        // A bookmark this process cannot resolve: the container, named after the folder, and a report.
        space.folderLink = FolderLink(bookmark: Data("not a bookmark".utf8), name: "My Notes", pickedAt: Date())
        let t2 = try XCTUnwrap(NativeTarget.forExtension(space: space, defaultName: "App Name"))
        XCTAssertEqual(t2.name, "My Notes")
        XCTAssertEqual(t2.store.root, space.storeRoot.standardizedFileURL)
        XCTAssertEqual(space.extensionAccess?.direct, false)

        XCTAssertNil(NativeTarget.forExtension(space: nil, defaultName: "App Name"))
    }

    func testExtensionTargetUsesFolderWhenBookmarkOpens() throws {
        let space = SharedSpace(root: root)
        let folder = try tempDir(self)
        let bookmark = try folder.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        space.folderLink = FolderLink(bookmark: bookmark, name: folder.lastPathComponent, pickedAt: Date())
        // Outside the sandbox a plain bookmark resolves, which is the direct path.
        #if os(macOS)
        // Security-scoped resolution of a plain bookmark fails on macOS, so the container is used.
        let t = try XCTUnwrap(NativeTarget.forExtension(space: space, defaultName: "App Name"))
        XCTAssertEqual(t.store.root, space.storeRoot.standardizedFileURL)
        XCTAssertEqual(space.extensionAccess?.direct, false)
        #else
        let t = try XCTUnwrap(NativeTarget.forExtension(space: space, defaultName: "App Name"))
        XCTAssertEqual(t.store.root.resolvingSymlinksInPath(), folder.resolvingSymlinksInPath())
        XCTAssertEqual(space.extensionAccess?.direct, true)
        XCTAssertTrue(t.store.coordinated)
        #endif
    }
}
