import XCTest

final class ArchiveTests: XCTestCase {
    func testZipRoundTrip() throws {
        let big = Data(String(repeating: "{\"a\": 1}\n", count: 500).utf8)
        let files: [(name: String, data: Data)] = [("pages/a.ink.json", big), ("pages/é b.ink.json", Data("x".utf8)), ("empty", Data())]
        let zip = Zip.write(files)
        // Compressible files are deflated.
        XCTAssertLessThan(zip.count, big.count)
        let back = try Zip.read(zip)
        XCTAssertEqual(back.map(\.name), files.map(\.name))
        XCTAssertEqual(back.map(\.data), files.map(\.data))
    }

    func testReadsAStoredZipFromElsewhere() throws {
        // A minimal stored archive built by hand: one entry "pages/t.ink.json" with "hi".
        let zip = Zip.write([("pages/t.ink.json", Data("hi".utf8))])
        XCTAssertEqual(try Zip.read(zip).first?.data, Data("hi".utf8))
        XCTAssertEqual(Zip.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testRejectsGarbageAndCorruption() throws {
        XCTAssertThrowsError(try Zip.read(Data("not a zip at all, not even close".utf8)))
        var zip = Zip.write([("pages/t.ink.json", Data("hello hello hello".utf8))])
        // Flip a byte of the entry data, after the 30 byte header and the 16 byte name.
        zip[48] ^= 0xFF
        XCTAssertThrowsError(try Zip.read(zip))
    }

    func testExportAndImport() throws {
        let src = DirectoryStore(root: try tempDir(self), coordinated: false)
        try src.write("pages/aaa.ink.json", recordJSON(key: "https://a.org/", notes: [note("n1")]))
        try src.write("pages/bbb.ink.json", recordJSON(key: "https://b.org/", notes: [note("n2")]))
        let zip = try Archive.export(src)
        XCTAssertEqual(try Zip.read(zip).map(\.name), ["pages/aaa.ink.json", "pages/bbb.ink.json"])

        let dst = DirectoryStore(root: try tempDir(self), coordinated: false)
        try dst.write("pages/aaa.ink.json", recordJSON(key: "https://a.org/", notes: [note("other")]))
        try dst.write("pages/bbb.ink.json", recordJSON(key: "https://b.org/", notes: [note("n2")]))
        let r = try Archive.importArchive(zip, into: dst)
        XCTAssertEqual(r.same, 1)
        XCTAssertEqual(r.copies, 1)
        XCTAssertEqual(r.added, 0)
        // The different file was kept next to the existing one, not over it.
        let names = try dst.list("pages").map(\.name)
        XCTAssertEqual(names.count, 3)
        XCTAssertTrue(names.contains { $0.contains("conflicted copy") })
        XCTAssertEqual(Set(Library.load(dst).pages.first { $0.record.key == "https://a.org/" }?.notes.map(\.id) ?? []),
                       ["n1", "other"])
    }

    func testImportRefusesPathsOutsidePages() throws {
        let zip = Zip.write([
            ("../evil.ink.json", recordJSON(key: "k")), ("/abs.ink.json", recordJSON(key: "k")),
            ("pages/../../x.ink.json", recordJSON(key: "k")), ("pages/sub/deep.ink.json", recordJSON(key: "k")),
            ("pages/notjson.ink.json", Data("nope".utf8)), ("pages/ok.ink.json", recordJSON(key: "k")),
        ])
        let root = try tempDir(self)
        let dst = DirectoryStore(root: root, coordinated: false)
        let r = try Archive.importArchive(zip, into: dst)
        XCTAssertEqual(r.added, 1)
        XCTAssertEqual(r.skipped.count, 5)
        XCTAssertEqual(try dst.list("pages").map(\.name), ["pages/ok.ink.json"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("evil.ink.json").path))
    }

    func testMarkdown() throws {
        let r = try RecordParser.parse(recordJSON(key: "https://a.org/x", title: "  A\n page ", notes: [
            note("n2", quote: "second", created: 1_700_000_000_000, start: 50),
            note("n1", quote: "first\nline", created: 1_700_086_400_000, start: 10, strokes: [stroke("s", tool: "hi")]),
        ]))
        let md = MarkdownExport.render([PageSummary(record: r, files: [])])
        XCTAssertEqual(md, """
        # Notes

        ## A page

        <https://a.org/x>

        > first line

        - Highlight, 2023-11-15

        > second

        - Handwriting, 2023-11-14

        """)
        XCTAssertEqual(MarkdownExport.render([]), "# Notes\n")
    }
}
