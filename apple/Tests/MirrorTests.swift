import XCTest

final class MirrorTests: XCTestCase {
    var a: DirectoryStore!
    var b: DirectoryStore!
    var state = MirrorState()

    override func setUpWithError() throws {
        a = DirectoryStore(root: try tempDir(self), coordinated: false)
        b = DirectoryStore(root: try tempDir(self), coordinated: true)
        state = MirrorState()
    }

    private func put(_ s: DirectoryStore, _ name: String, _ text: String, at t: Int64) throws {
        try s.write("pages/\(name)", Data(text.utf8), mtime: t)
    }

    private func text(_ s: DirectoryStore, _ name: String) -> String? {
        (try? s.read("pages/\(name)")).map { String(decoding: $0, as: UTF8.self) }
    }

    private func names(_ s: DirectoryStore) -> [String] {
        ((try? s.list("pages")) ?? []).map { String($0.name.dropFirst("pages/".count)) }
    }

    @discardableResult
    private func mirror(_ now: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> MirrorReport {
        Mirror(store: a, folder: b).run(state: &state, now: now)
    }

    func testCopiesNewFilesBothWays() throws {
        try put(a, "one.ink.json", "A1", at: 1_000_000)
        try put(b, "two.ink.json", "B2", at: 2_000_000)
        let r = mirror()
        XCTAssertEqual(r.toFolder, 1)
        XCTAssertEqual(r.toStore, 1)
        XCTAssertEqual(text(b, "one.ink.json"), "A1")
        XCTAssertEqual(text(a, "two.ink.json"), "B2")
        // The copy keeps the source's time, so it does not look newer than it is.
        XCTAssertEqual(try b.entry("pages/one.ink.json")?.mtime, 1_000_000)
        XCTAssertNotNil(state.lastMirror)

        // A second run has nothing to do.
        XCTAssertFalse(mirror().changed)
    }

    func testOneSideChangedWins() throws {
        try put(a, "p.ink.json", "v1", at: 1_000_000)
        mirror()
        try put(b, "p.ink.json", "v2 from folder", at: 2_000_000)
        var r = mirror()
        XCTAssertEqual(r.toStore, 1)
        XCTAssertEqual(text(a, "p.ink.json"), "v2 from folder")

        try put(a, "p.ink.json", "v3 from safari", at: 3_000_000)
        r = mirror()
        XCTAssertEqual(r.toFolder, 1)
        XCTAssertEqual(text(b, "p.ink.json"), "v3 from safari")
        XCTAssertEqual(r.conflicts, 0)
    }

    func testOlderChangeOnOneSideStillCopies() throws {
        // What matters is that only one side changed, not which clock is ahead.
        try put(a, "p.ink.json", "v1", at: 5_000_000)
        mirror()
        try put(b, "p.ink.json", "edited elsewhere", at: 4_000_000)
        mirror()
        XCTAssertEqual(text(a, "p.ink.json"), "edited elsewhere")
    }

    func testBothChangedKeepsBothCopies() throws {
        try put(a, "p.ink.json", "base", at: 1_000_000)
        mirror()
        try put(a, "p.ink.json", "safari", at: 3_000_000)
        try put(b, "p.ink.json", "folder", at: 2_000_000)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let r = mirror(now)
        XCTAssertEqual(r.conflicts, 1)
        // The newer copy takes the name on both sides.
        XCTAssertEqual(text(a, "p.ink.json"), "safari")
        XCTAssertEqual(text(b, "p.ink.json"), "safari")
        // The other one sits next to it on both sides.
        let copy = String(Mirror.conflictName("pages/p.ink.json", date: now).dropFirst("pages/".count))
        XCTAssertTrue(copy.hasPrefix("p (conflicted copy "))
        XCTAssertTrue(copy.hasSuffix(").ink.json"))
        XCTAssertEqual(text(a, copy), "folder")
        XCTAssertEqual(text(b, copy), "folder")
        XCTAssertEqual(Set(names(a)), Set(names(b)))

        // Settled: nothing more to do.
        XCTAssertFalse(mirror().changed)
    }

    func testBothChangedFolderNewerWins() throws {
        try put(a, "p.ink.json", "base", at: 1_000_000)
        mirror()
        try put(a, "p.ink.json", "safari", at: 2_000_000)
        try put(b, "p.ink.json", "folder", at: 3_000_000)
        mirror()
        XCTAssertEqual(text(a, "p.ink.json"), "folder")
        let copies = names(a).filter { $0.contains("conflicted copy") }
        XCTAssertEqual(copies.count, 1)
        XCTAssertEqual(text(a, copies[0]), "safari")
    }

    func testFirstMirrorWithDifferentFilesOfSameNameIsAConflict() throws {
        try put(a, "p.ink.json", "here", at: 1_000_000)
        try put(b, "p.ink.json", "there", at: 2_000_000)
        let r = mirror()
        XCTAssertEqual(r.conflicts, 1)
        XCTAssertEqual(text(a, "p.ink.json"), "there")
    }

    func testSameContentOnBothSidesIsNotAConflict() throws {
        try put(a, "p.ink.json", "same", at: 1_000_000)
        try put(b, "p.ink.json", "same", at: 2_000_000)
        let r = mirror()
        XCTAssertEqual(r.conflicts, 0)
        XCTAssertEqual(names(a), ["p.ink.json"])
    }

    func testRemovalTravelsBothWays() throws {
        try put(a, "x.ink.json", "x", at: 1_000_000)
        try put(a, "y.ink.json", "y", at: 1_000_000)
        mirror()
        try a.remove("pages/x.ink.json")
        try b.remove("pages/y.ink.json")
        let r = mirror()
        XCTAssertEqual(r.removed, 2)
        XCTAssertEqual(names(a), [])
        XCTAssertEqual(names(b), [])
        XCTAssertTrue(state.files.isEmpty)
    }

    func testChangeBeatsRemoval() throws {
        try put(a, "x.ink.json", "x", at: 1_000_000)
        mirror()
        try b.remove("pages/x.ink.json")
        try put(a, "x.ink.json", "x edited", at: 2_000_000)
        let r = mirror()
        XCTAssertEqual(r.removed, 0)
        XCTAssertEqual(text(b, "x.ink.json"), "x edited")
    }

    func testPlaceholderWaitsAndRemovesNothing() throws {
        try put(a, "x.ink.json", "x", at: 1_000_000)
        mirror()
        // iCloud evicted the folder's copy: only ".x.ink.json.icloud" is left.
        let pages = b.root.appendingPathComponent("pages")
        try FileManager.default.removeItem(at: pages.appendingPathComponent("x.ink.json"))
        try Data().write(to: pages.appendingPathComponent(".x.ink.json.icloud"))
        let r = mirror()
        XCTAssertEqual(r.waiting, 1)
        XCTAssertEqual(r.removed, 0)
        XCTAssertEqual(text(a, "x.ink.json"), "x")
    }

    func testOnlyPagesAreMirrored() throws {
        try a.write("other/z.txt", Data("z".utf8))
        try put(a, "p.ink.json", "p", at: 1_000_000)
        mirror()
        XCTAssertNil(try? b.read("other/z.txt"))
        XCTAssertEqual(names(b), ["p.ink.json"])
    }

    func testFolderTimesAreKeptInState() throws {
        try put(a, "p.ink.json", "p", at: 1_000_000)
        mirror()
        XCTAssertEqual(state.files["pages/p.ink.json"], MirrorBase(a: 1_000_000, b: 1_000_000))
    }

    func testConflictNamesAreUnique() {
        let d = Date(timeIntervalSince1970: 1_800_000_000)
        let first = Mirror.conflictName("pages/p.ink.json", date: d)
        let second = Mirror.conflictName("pages/p.ink.json", date: d, taken: [first])
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(second.hasSuffix(" 2).ink.json"))
        // The extension treats such names as copies: they contain ".ink" and end in ".json".
        XCTAssertTrue(SafeName.isSafe(first))
    }

    func testOverflowFilesMirrorAndConflictLikeAnyOther() throws {
        try put(a, "p.1.ink.json", "A1", at: 1_000_000)
        mirror()
        XCTAssertEqual(text(b, "p.1.ink.json"), "A1")
        try put(a, "p.1.ink.json", "A2", at: 2_000_000)
        try put(b, "p.1.ink.json", "B2", at: 3_000_000)
        XCTAssertEqual(mirror().conflicts, 1)
        XCTAssertEqual(text(a, "p.1.ink.json"), "B2")
        // The copy keeps the overflow name as its stem, so the extension folds it into that page.
        let copy = try XCTUnwrap(names(a).first { $0.hasPrefix("p.1 (conflicted copy ") })
        XCTAssertTrue(copy.hasSuffix(").ink.json"))
        XCTAssertEqual(text(a, copy), "A2")
    }

    func testUnreachableFolderReportsAnError() throws {
        try put(a, "p.ink.json", "p", at: 1_000_000)
        let gone = DirectoryStore(root: URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)"), coordinated: false)
        // A missing folder lists as empty, so the store's file is copied and the write fails.
        var s = MirrorState()
        let r = Mirror(store: a, folder: gone).run(state: &s)
        XCTAssertFalse(r.errors.isEmpty)
        XCTAssertEqual(text(a, "p.ink.json"), "p")
    }
}
