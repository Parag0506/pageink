import Foundation
import XCTest

/// A fresh folder per test, removed afterwards.
func tempDir(_ test: XCTestCase) throws -> URL {
    let u = FileManager.default.temporaryDirectory
        .appendingPathComponent("ink-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    test.addTeardownBlock { try? FileManager.default.removeItem(at: u) }
    return u
}

/// A small valid record, as the extension writes it.
func recordJSON(key: String, title: String = "Page", updatedAt: Int = 1_700_000_000_000,
                notes: [[String: Any]] = [], deleted: [[String: Any]] = []) -> Data {
    let o: [String: Any] = [
        "v": 1, "key": key, "urls": [key, "host:example.org"], "title": title,
        "updatedAt": updatedAt, "notes": notes, "deleted": deleted,
    ]
    return try! JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])
}

/// An ink note has one stroke unless the test gives its strokes: an ink note with none shows nothing.
func note(_ id: String, quote: String = "", created: Int = 1_700_000_000_000, start: Int = 0,
          strokes: [[String: Any]]? = nil, kind: String = "ink", updated: Int? = nil) -> [String: Any] {
    [
        "id": id, "createdAt": created, "updatedAt": updated ?? created, "device": "test", "kind": kind,
        "anchor": [
            "type": "text", "quote": ["exact": quote, "prefix": "", "suffix": ""],
            "path": ["css": "p", "xpath": "/p"], "pos": ["start": start, "end": start + quote.count],
            "hash": "h", "place": "on",
        ],
        "frame": ["w": 100, "h": 20, "fontPx": 16, "viewportW": 1024],
        "strokes": strokes ?? (kind == "ink" ? [stroke("\(id).s", t: created)] : []),
    ]
}

func stroke(_ id: String, d: String = "M1,1l10,0l0,10Z", tool: String = "pen", color: String = "ink-1", t: Int = 1) -> [String: Any] {
    ["id": id, "t": t, "tool": tool, "color": color, "w": 2, "pts": [10, 10, 50], "d": d]
}

/// XCTAssertEqual for values that need `await`: XCTest's own takes autoclosures, which cannot wait.
func same<T: Equatable>(_ a: T?, _ b: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a, b, message, file: file, line: line)
}

func none<T>(_ a: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(a, message, file: file, line: line)
}
