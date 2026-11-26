import XCTest

final class ReviewRuleTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let day: TimeInterval = 24 * 60 * 60

    /// `n` pages with one note each, the first note written `age` days before now.
    func pages(_ n: Int, ageDays age: Double) throws -> [PageSummary] {
        let first = Int((now.timeIntervalSince1970 - age * day) * 1000)
        return try (0..<n).map { i in
            let r = try RecordParser.parse(recordJSON(key: "https://example.org/\(i)", updatedAt: first + i * 1000,
                                                      notes: [note("n\(i)", created: first + i * 1000)]))
            return PageSummary(record: r, files: [])
        }
    }

    func testTheRuleIsFivePagesAndThreeDays() {
        XCTAssertEqual(ReviewRule.pages, 5)
        XCTAssertEqual(ReviewRule.days, 3)
    }

    func testAsksAfterRealUse() throws {
        XCTAssertTrue(ReviewRule.due(try pages(5, ageDays: 3), askedVersion: "", version: "0.1.3", now: now))
        XCTAssertTrue(ReviewRule.due(try pages(30, ageDays: 60), askedVersion: "0.1.2", version: "0.1.3", now: now))
    }

    func testWaitsForTheFifthPage() throws {
        XCTAssertFalse(ReviewRule.due(try pages(4, ageDays: 30), askedVersion: "", version: "0.1.3", now: now))
        XCTAssertFalse(ReviewRule.due([], askedVersion: "", version: "0.1.3", now: now))
    }

    func testWaitsForThreeDays() throws {
        XCTAssertFalse(ReviewRule.due(try pages(9, ageDays: 2.9), askedVersion: "", version: "0.1.3", now: now))
        XCTAssertFalse(ReviewRule.due(try pages(9, ageDays: 0), askedVersion: "", version: "0.1.3", now: now))
    }

    func testAsksAtMostOncePerVersion() throws {
        XCTAssertFalse(ReviewRule.due(try pages(9, ageDays: 9), askedVersion: "0.1.3", version: "0.1.3", now: now))
        XCTAssertFalse(ReviewRule.due(try pages(9, ageDays: 9), askedVersion: "", version: "", now: now))
    }

    func testAFirstNoteInTheFutureWaits() {
        XCTAssertFalse(ReviewRule.due(pageCount: 9, firstUse: now.addingTimeInterval(day), askedVersion: "", version: "1", now: now))
        XCTAssertFalse(ReviewRule.due(pageCount: 9, firstUse: nil, askedVersion: "", version: "1", now: now))
    }

    func testFirstUseIsTheEarliestNote() throws {
        let list = try pages(3, ageDays: 10)
        XCTAssertEqual(ReviewRule.firstUse(list)?.timeIntervalSince1970 ?? 0, now.timeIntervalSince1970 - 10 * day, accuracy: 0.01)
        XCTAssertNil(ReviewRule.firstUse([]))
    }
}
