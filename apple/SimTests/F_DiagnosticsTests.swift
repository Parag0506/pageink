import XCTest

/// Only with INK_SIM_DIAG=1, which builds the diagnostics variant of the extension for the
/// device check (apple/device) with this Mac's test server as its one origin. It checks what can
/// be checked without an Apple Pencil: the channel to that origin works in Mobile Safari, and the
/// background answers whether every website is allowed. Strokes in the PDF viewer need a Pencil.
final class F_DiagnosticsTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  override func tearDown() {
    attach(self, name)
  }

  func test01_CheckPageHearsTheExtension() throws {
    guard ProcessInfo.processInfo.environment["INK_DIAG"] == "1" else {
      throw XCTSkip("Only with INK_SIM_DIAG=1")
    }
    Sim.safari.launch()
    Sim.safari.open(Sim.url("diag.html"))
    let line = Sim.safari.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'diag '")).firstMatch
    var label = ""
    let ok = waitFor(20) {
      label = line.exists ? line.label : ""
      return label.contains("all=true")
    }
    note("diag", label.isEmpty ? "no line" : label)
    XCTAssertTrue(ok, "The diagnostics build did not say hello with every website allowed: \(label)")
    XCTAssertTrue(label.contains("viewer=yes"), "The hello does not name the PDF viewer: \(label)")
  }
}
