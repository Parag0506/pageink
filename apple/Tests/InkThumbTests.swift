import CoreGraphics
import XCTest

/// The small drawing the Notes list shows for a page (Shared/InkThumb.swift).
final class InkThumbTests: XCTestCase {
    func notes(_ list: [[String: Any]]) throws -> [InkNote] {
        try RecordParser.parse(recordJSON(key: "https://a.org/", notes: list)).liveNotes
    }

    func box(_ item: ThumbItem, _ kind: ThumbShape.Kind) throws -> CGRect {
        try XCTUnwrap(item.shapes.first { $0.kind == kind }, "no \(kind) shape").path.boundingBoxOfPath
    }

    func index(_ item: ThumbItem, _ kind: ThumbShape.Kind) -> Int? {
        item.shapes.firstIndex { $0.kind == kind }
    }

    /// The page from the report: a highlight and an underline on text, and no free-hand stroke.
    func testAPageWithOnlyTextMarksGetsADrawing() throws {
        let page = try notes([
            textMark("h", "highlight", color: "hi-2", quote: "the quick brown fox", updated: 2),
            textMark("u", "underline", color: "ink-2", quote: "jumps over", updated: 1),
        ])
        XCTAssertEqual(page.count, 2)
        XCTAssertTrue(page.allSatisfy { $0.strokes.isEmpty })
        let items = InkThumb.items(page)
        XCTAssertEqual(items.count, 2, "A page with only text marks fell back to the placeholder")
        for item in items {
            XCTAssertFalse(item.box.isNull || item.box.isEmpty)
            for s in item.shapes {
                XCTAssertTrue(item.box.insetBy(dx: -0.01, dy: -0.01).contains(s.path.boundingBoxOfPath))
            }
        }
    }

    func testAHighlightIsABandBehindTheWordsInItsColour() throws {
        let item = try XCTUnwrap(InkThumb.items(try notes([
            textMark("h", "highlight", color: "hi-2", quote: "the quick brown fox"),
        ])).first)
        let band = try box(item, .marker)
        let words = try box(item, .words)
        XCTAssertEqual(item.shapes.first { $0.kind == .marker }?.color, "hi-2")
        XCTAssertTrue(band.contains(words), "The band does not cover the words: \(band) \(words)")
        XCTAssertGreaterThan(band.height, words.height)
        // The band is painted first, so the words show on it.
        XCTAssertLessThan(try XCTUnwrap(index(item, .marker)), try XCTUnwrap(index(item, .words)))
        XCTAssertNil(index(item, .line))
    }

    func testAnUnderlineIsAThinLineUnderTheWordsInItsColour() throws {
        let item = try XCTUnwrap(InkThumb.items(try notes([
            textMark("u", "underline", color: "ink-2", quote: "jumps over"),
        ])).first)
        let line = try box(item, .line)
        let words = try box(item, .words)
        XCTAssertEqual(item.shapes.first { $0.kind == .line }?.color, "ink-2")
        XCTAssertGreaterThanOrEqual(line.minY, words.maxY, "The line is not under the words")
        XCTAssertLessThan(line.height, words.height, "The line is as thick as the words")
        XCTAssertLessThanOrEqual(line.minX, words.minX)
        XCTAssertGreaterThanOrEqual(line.maxX, words.maxX)
        XCTAssertNil(index(item, .marker))
    }

    func testAStrikeIsALineThroughTheWords() throws {
        let item = try XCTUnwrap(InkThumb.items(try notes([
            textMark("s", "strike", color: "ink-1", quote: "not this"),
        ])).first)
        let line = try box(item, .line)
        let words = try box(item, .words)
        XCTAssertGreaterThan(line.midY, words.minY)
        XCTAssertLessThan(line.midY, words.maxY)
        // Painted after the words, so it shows on them.
        XCTAssertGreaterThan(try XCTUnwrap(index(item, .line)), try XCTUnwrap(index(item, .words)))
    }

    func testAMarkWithoutAStyleOrColourIsAHighlightInTheFirstColour() throws {
        let item = try XCTUnwrap(InkThumb.items(try notes([note("m", quote: "words", kind: "textmark")])).first)
        XCTAssertEqual(item.shapes.first { $0.kind == .marker }?.color, "hi-1")
        let under = try XCTUnwrap(InkThumb.items(try notes([
            note("m", quote: "words", kind: "textmark", mark: ["style": "underline"]),
        ])).first)
        XCTAssertEqual(under.shapes.first { $0.kind == .line }?.color, "ink-1")
    }

    func testALongQuoteWrapsAndStopsAtThreeLines() throws {
        let one = try XCTUnwrap(InkThumb.items(try notes([textMark("a", "highlight", color: "hi-1", quote: "word")])).first)
        let long = String(repeating: "several words in a row ", count: 30)
        let many = try XCTUnwrap(InkThumb.items(try notes([textMark("b", "highlight", color: "hi-1", quote: long)])).first)
        XCTAssertEqual(many.box.height, one.box.height * 3, accuracy: 0.01)
        XCTAssertGreaterThan(many.box.width, one.box.width)
        // Text without spaces still fills lines, and an empty quote still draws.
        let cjk = try XCTUnwrap(InkThumb.items(try notes([
            textMark("c", "highlight", color: "hi-1", quote: String(repeating: "\u{6587}", count: 40)),
        ])).first)
        XCTAssertGreaterThan(cjk.box.height, one.box.height)
        XCTAssertNotNil(InkThumb.items(try notes([textMark("d", "underline", color: "ink-1", quote: "")])).first)
    }

    func testInkStrokesAreDrawnFromTheirPaths() throws {
        let item = try XCTUnwrap(InkThumb.items(try notes([
            note("n", strokes: [
                stroke("p", d: "M1,1l10,0l0,10Z", t: 1),
                stroke("h", d: "M20,0l5,0l0,30Z", tool: "hi", color: "hi-1", t: 2),
            ]),
        ])).first)
        XCTAssertEqual(item.shapes.map(\.kind), [.pen, .marker])
        XCTAssertEqual(item.shapes.map(\.color), ["ink-1", "hi-1"])
        XCTAssertEqual(item.box, CGRect(x: 1, y: 0, width: 24, height: 30))
    }

    func testTheNewestThreeNotesThatDrawAreShown() throws {
        let page = try notes([
            note("old", strokes: [stroke("o", t: 1)], updated: 1),
            textMark("h", "highlight", color: "hi-1", quote: "one two", updated: 2),
            // A stroke whose path draws nothing gives its place to the next note.
            note("blank", strokes: [stroke("b", d: "", t: 3)], updated: 3),
            note("pen", strokes: [stroke("p", t: 4)], updated: 4),
            textMark("u", "underline", color: "ink-1", quote: "three", updated: 5),
        ])
        let items = InkThumb.items(page)
        XCTAssertEqual(items.map { $0.shapes.map(\.kind) }, [[.words, .line], [.pen], [.marker, .words]])
    }

    func testColoursFollowTheExtensionsPalettes() {
        XCTAssertEqual(InkPalette.rgb("hi-2", hi: true, dark: false), 0x8FE3A1)
        XCTAssertEqual(InkPalette.rgb("hi-2", hi: true, dark: true), 0x1F7A3C)
        XCTAssertEqual(InkPalette.rgb("ink-2", hi: false, dark: false), 0xD03A2F)
        XCTAssertEqual(InkPalette.rgb("#0a0", hi: false, dark: false), 0x00AA00)
        XCTAssertEqual(InkPalette.rgb("#12ab34", hi: true, dark: true), 0x12AB34)
        // Anything else is the first colour of its tool.
        XCTAssertEqual(InkPalette.rgb("url(x)", hi: true, dark: false), 0xFFE14D)
        XCTAssertEqual(InkPalette.rgb("", hi: false, dark: true), 0xE8ECF4)
    }
}
