import XCTest

final class RecordTests: XCTestCase {
    func testParsesRecord() throws {
        let data = recordJSON(key: "https://example.org/a", title: "A page", notes: [
            note("n1", quote: "hello world", start: 40, strokes: [stroke("s1", t: 2), stroke("s2", tool: "hi", color: "hi-1", t: 1)]),
            note("n2", quote: "gone"),
        ], deleted: [["id": "n2", "t": 1_800_000_000_000]])
        let r = try RecordParser.parse(data)
        XCTAssertEqual(r.key, "https://example.org/a")
        XCTAssertEqual(r.title, "A page")
        XCTAssertEqual(r.notes.count, 2)
        XCTAssertEqual(r.deleted["n2"], 1_800_000_000_000)
        let live = r.liveNotes
        XCTAssertEqual(live.map(\.id), ["n1"])
        XCTAssertEqual(live[0].quote, "hello world")
        XCTAssertEqual(live[0].posStart, 40)
        // Strokes are in time order.
        XCTAssertEqual(live[0].strokes.map(\.id), ["s2", "s1"])
        XCTAssertEqual(live[0].strokes[0].tool, "hi")
    }

    func testRejectsNonRecords() {
        XCTAssertThrowsError(try RecordParser.parse(Data("not json".utf8)))
        XCTAssertThrowsError(try RecordParser.parse(Data("[1,2]".utf8)))
        XCTAssertThrowsError(try RecordParser.parse(Data(#"{"v":2,"key":"k","notes":[]}"#.utf8)))
        XCTAssertThrowsError(try RecordParser.parse(Data(#"{"v":1,"notes":[]}"#.utf8)))
        XCTAssertThrowsError(try RecordParser.parse(Data(#"{"v":1,"key":"k"}"#.utf8)))
        XCTAssertThrowsError(try RecordParser.parse(Data(#"{"v":true,"key":"k","notes":[]}"#.utf8)))
    }

    func testToleratesMissingOptionalFields() throws {
        let r = try RecordParser.parse(Data(#"{"v":1,"key":"k","notes":[{"id":"a"},{"no":"id"}]}"#.utf8))
        XCTAssertEqual(r.notes.map(\.id), ["a"])
        XCTAssertEqual(r.title, "")
        XCTAssertEqual(r.address, "k")
    }

    func testAddressPrefersWebKeyThenWebUrl() throws {
        var r = try RecordParser.parse(recordJSON(key: "https://a.org/x"))
        XCTAssertEqual(r.address, "https://a.org/x")
        XCTAssertEqual(r.host, "a.org")
        r.key = "pdf:abc"
        r.urls = ["host:a.org", "pdf:abc", "https://b.org/doc.pdf"]
        XCTAssertEqual(r.address, "https://b.org/doc.pdf")
    }

    func testLibraryGroupsCopiesByKeyAndHidesEmptyPages() throws {
        let store = DirectoryStore(root: try tempDir(self), coordinated: false)
        try store.write("pages/aaa.ink.json", recordJSON(key: "https://a.org/", title: "Old", updatedAt: 1, notes: [note("n1")]))
        try store.write("pages/aaa (conflicted copy 2026-01-01 1200).ink.json",
                        recordJSON(key: "https://a.org/", title: "New", updatedAt: 2, notes: [note("n2")]))
        try store.write("pages/bbb.ink.json", recordJSON(key: "https://b.org/", notes: [note("x")], deleted: [["id": "x", "t": 1_800_000_000_000]]))
        try store.write("pages/bad.ink.json", Data("{".utf8))
        let (pages, errors, _) = Library.load(store)
        XCTAssertEqual(pages.count, 1)
        XCTAssertEqual(pages[0].title, "New")
        XCTAssertEqual(Set(pages[0].notes.map(\.id)), ["n1", "n2"])
        XCTAssertEqual(pages[0].files.count, 2)
        XCTAssertEqual(errors, ["pages/bad.ink.json"])
    }

    func testSearchMatchesTitleAddressAndQuotes() throws {
        let r = try RecordParser.parse(recordJSON(key: "https://example.org/café", title: "Résumé tips",
                                                  notes: [note("n", quote: "the quick brown fox")]))
        let p = PageSummary(record: r, files: [])
        XCTAssertTrue(Library.matches(p, "resume"))
        XCTAssertTrue(Library.matches(p, "EXAMPLE.org"))
        XCTAssertTrue(Library.matches(p, "brown"))
        XCTAssertTrue(Library.matches(p, " "))
        XCTAssertFalse(Library.matches(p, "zebra"))
    }

    func testRemovingAllNotesWritesTombstones() throws {
        let data = recordJSON(key: "k", updatedAt: 10, notes: [note("n1", strokes: [stroke("s1")]), note("n2")],
                              deleted: [["id": "old", "t": 1]])
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let out = try RecordEditor.removingAllNotes(data, now: now)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: out) as? [String: Any])
        XCTAssertEqual((o["notes"] as? [Any])?.count, 0)
        let ids = (o["deleted"] as? [[String: Any]])?.compactMap { $0["id"] as? String }
        XCTAssertEqual(Set(ids ?? []), ["old", "n1", "s1", "n2", "n2.s"])
        XCTAssertEqual((o["updatedAt"] as? NSNumber)?.int64Value, 1_800_000_000_000)
        // Other fields stay.
        XCTAssertEqual(o["key"] as? String, "k")
        XCTAssertEqual((o["urls"] as? [String])?.first, "k")
        XCTAssertEqual(out.last, 0x0A)
        // The result is still a valid record with no live notes.
        XCTAssertTrue(try RecordParser.parse(out).liveNotes.isEmpty)
    }

    func testStrokesWrittenAfterADeletionSurviveUnderTheLaterId() throws {
        // Deleted at 200 on one device; another had a stroke at 100 and added one at 300.
        let dead = try RecordParser.parse(recordJSON(key: "k", updatedAt: 200, deleted: [["id": "n", "t": 200]]))
        let late = try RecordParser.parse(recordJSON(key: "k", updatedAt: 300, notes: [
            note("n", created: 50, strokes: [stroke("early", t: 100), stroke("late", t: 300)], updated: 300),
        ]))
        let f = dead.folded(with: late)
        XCTAssertEqual(InkRecord.laterId("n", 200), "n~5k")
        XCTAssertEqual(f.liveNotes.map(\.id), ["n~5k"])
        XCTAssertEqual(f.liveNotes[0].strokes.map(\.id), ["late"])
        XCTAssertEqual(late.folded(with: dead).liveNotes.map(\.id), ["n~5k"])
        // A record the extension already merged reads the same, and a later deletion covers it.
        let merged = try RecordParser.parse(recordJSON(key: "k", updatedAt: 300, notes: [
            note("n~5k", created: 50, strokes: [stroke("late", t: 300)], updated: 300),
        ], deleted: [["id": "n", "t": 200], ["id": "early", "t": 200]]))
        XCTAssertEqual(merged.liveNotes.map(\.id), ["n~5k"])
        let gone = try RecordParser.parse(recordJSON(key: "k", deleted: [["id": "n~5k", "t": 400]]))
        XCTAssertTrue(merged.folded(with: gone).liveNotes.isEmpty)
    }

    func testAnInkNoteLeftWithNoStrokesIsNotShownOrCounted() throws {
        let store = DirectoryStore(root: try tempDir(self), coordinated: false)
        // Edited at 250 after a deletion at 200, with no stroke written after it.
        try store.write("pages/aaa.ink.json", recordJSON(key: "https://a.org/", updatedAt: 250, notes: [
            note("n", created: 50, strokes: [stroke("s", t: 100)], updated: 250),
        ], deleted: [["id": "n", "t": 200]]))
        try store.write("pages/bbb.ink.json", recordJSON(key: "https://b.org/", notes: [
            note("m"), note("empty", strokes: []), note("mark", kind: "textmark"),
        ]))
        let pages = Library.load(store).pages
        XCTAssertEqual(pages.map(\.record.key), ["https://b.org/"])
        XCTAssertEqual(pages[0].notes.map(\.id), ["m", "mark"])
        XCTAssertFalse(MarkdownExport.render(pages).contains("empty"))
    }

    func testOverflowFilesAreReadAsTheirOwnPages() throws {
        let store = DirectoryStore(root: try tempDir(self), coordinated: false)
        try store.write("pages/aaa.ink.json", recordJSON(key: "https://a.org/", notes: [note("a")]))
        try store.write("pages/aaa.1.ink.json", recordJSON(key: "https://b.org/", notes: [note("b")]))
        try store.write("pages/aaa.1 (conflicted copy 2026-01-01 1200).ink.json",
                        recordJSON(key: "https://b.org/", updatedAt: 1_700_000_000_001, notes: [note("c")]))
        let (pages, errors, _) = Library.load(store)
        XCTAssertEqual(errors, [])
        XCTAssertEqual(Set(pages.map(\.record.key)), ["https://a.org/", "https://b.org/"])
        let b = try XCTUnwrap(pages.first { $0.record.key == "https://b.org/" })
        XCTAssertEqual(Set(b.notes.map(\.id)), ["b", "c"])
        XCTAssertEqual(b.files.sorted(), ["pages/aaa.1 (conflicted copy 2026-01-01 1200).ink.json", "pages/aaa.1.ink.json"])
        // Export keeps the overflow names, and an import puts them back under the same names.
        let zip = try Archive.export(store)
        XCTAssertTrue(try Zip.read(zip).map(\.name).contains("pages/aaa.1.ink.json"))
        let dst = DirectoryStore(root: try tempDir(self), coordinated: false)
        XCTAssertEqual(try Archive.importArchive(zip, into: dst).added, 3)
        XCTAssertNotNil(try dst.entry("pages/aaa.1.ink.json"))
    }

    func testRemovingAllNotesKeepsTheLaterTime() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let future = 1_900_000_000_000
        let data = recordJSON(key: "k", notes: [
            note("n1", strokes: [stroke("s1", t: future)]),
            note("n2~5k", strokes: [stroke("s2", t: 1)]),
        ], deleted: [["id": "n2~5k", "t": future + 5], ["id": "n2", "t": 200]])
        let out = try RecordEditor.removingAllNotes(data, now: now)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: out) as? [String: Any])
        var t: [String: Int64] = [:]
        for d in (o["deleted"] as? [[String: Any]]) ?? [] { t[d["id"] as! String] = (d["t"] as! NSNumber).int64Value }
        // Never older than the newest stroke of the note, and a later time already there stays.
        XCTAssertEqual(t["n1"], Int64(future))
        XCTAssertEqual(t["s1"], Int64(future))
        XCTAssertEqual(t["n2~5k"], Int64(future + 5))
        XCTAssertEqual(t["s2"], 1_800_000_000_000)
        XCTAssertEqual(t["n2"], 200)
        XCTAssertEqual(t.count, 5)
        XCTAssertTrue(try RecordParser.parse(out).liveNotes.isEmpty)
    }

    func testFoldedMergesDeletedAndStrokes() throws {
        let one = try RecordParser.parse(recordJSON(key: "k", updatedAt: 1, notes: [note("n", strokes: [stroke("a", t: 1)])]))
        let two = try RecordParser.parse(recordJSON(key: "k", updatedAt: 2, notes: [note("n", strokes: [stroke("b", t: 2)])],
                                                    deleted: [["id": "a", "t": 3]]))
        let f = one.folded(with: two)
        XCTAssertEqual(f.updatedAt, 2)
        XCTAssertEqual(f.liveNotes.first?.strokes.map(\.id), ["b"])
        XCTAssertEqual(two.folded(with: one).liveNotes.first?.strokes.map(\.id), ["b"])
    }
}
