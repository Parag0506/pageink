import CoreGraphics
import XCTest

final class InkPathTests: XCTestCase {
    typealias S = InkPath.Segment
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

    func testFirstPointAbsoluteRestRelative() {
        // The shape the extension writes: absolute M, then relative commands.
        XCTAssertEqual(InkPath.parse("M10,20l5,0q1,1,2,2c1,0,2,0,3,1Z"), [
            .move(p(10, 20)), .line(p(15, 20)), .quad(p(16, 21), p(17, 22)),
            .cubic(p(18, 22), p(19, 22), p(20, 23)), .close,
        ])
    }

    func testCompactNumbers() {
        // "-.5" and ".5.5" as the writer joins them: no separators where the grammar allows none.
        XCTAssertEqual(InkPath.parse("M1.5-2.5l.5.5-1-1"), [.move(p(1.5, -2.5)), .line(p(2, -2)), .line(p(1, -3))])
        XCTAssertEqual(InkPath.parse("M0,0l-.5-.5"), [.move(p(0, 0)), .line(p(-0.5, -0.5))])
    }

    func testImplicitLinetoAfterMove() {
        XCTAssertEqual(InkPath.parse("M1,1 2,2 3,3"), [.move(p(1, 1)), .line(p(2, 2)), .line(p(3, 3))])
        XCTAssertEqual(InkPath.parse("m1,1 2,2"), [.move(p(1, 1)), .line(p(3, 3))])
    }

    func testRepeatedCommandArguments() {
        XCTAssertEqual(InkPath.parse("M0,0l1,0 1,0q1,1,2,0 1,1,2,0"), [
            .move(p(0, 0)), .line(p(1, 0)), .line(p(2, 0)), .quad(p(3, 1), p(4, 0)), .quad(p(5, 1), p(6, 0)),
        ])
    }

    func testAbsoluteCommandsAndClose() {
        XCTAssertEqual(InkPath.parse("M0 0 L10 0 L10 10 Z l5,5"), [
            .move(p(0, 0)), .line(p(10, 0)), .line(p(10, 10)), .close, .line(p(5, 5)),
        ])
    }

    func testSecondMoveIsRelativeToCurrentPoint() {
        XCTAssertEqual(InkPath.parse("M1,1l1,1zm2,2l1,0"), [
            .move(p(1, 1)), .line(p(2, 2)), .close, .move(p(3, 3)), .line(p(4, 3)),
        ])
    }

    func testExponentsAndJunk() {
        XCTAssertEqual(InkPath.parse("M1e1,2E-1"), [.move(p(10, 0.2))])
        // Unknown letters and stray numbers are skipped, and an unfinished command is dropped.
        XCTAssertEqual(InkPath.parse("5 M1,1 H9 l2"), [.move(p(1, 1))])
        XCTAssertEqual(InkPath.parse(""), [])
        XCTAssertEqual(InkPath.parse("Z"), [.close])
    }

    func testCGPathBounds() {
        let path = InkPath.cgPath("M10,10l20,0l0,10l-20,0Z")
        XCTAssertEqual(path.boundingBoxOfPath, CGRect(x: 10, y: 10, width: 20, height: 10))
        XCTAssertTrue(path.contains(CGPoint(x: 15, y: 15)))
    }

    func testLongStrokeParsesQuickly() {
        var d = "M100.5,200.5"
        for i in 0..<5000 { d += "q\(i % 7).5,-.\(i % 9),1.\(i % 5),\(i % 3)" }
        measure { _ = InkPath.parse(d) }
        XCTAssertEqual(InkPath.parse(d).count, 5001)
    }
}
