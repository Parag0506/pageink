import XCTest

/// Timings from the bench build's marks, read from the page's report line (sim/pages/report.js).
/// Times are in ms from the first byte of the page. Each check loads the page several times and
/// notes the median, so a slow load on a busy Mac does not decide the result.
///
/// - A site without ink (the server under the name localhost): when the stub starts, which comes
///   after the browser has parsed and run the whole content script, and the stub's own work.
/// - The same site, draw mode switched on: how long the background took to put the viewer and
///   the tools into the page.
/// - A page with ink: when the first ink is on screen, and whether the registered viewer ran.
final class H_TimingTests: XCTestCase {
  static let loads = 8

  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    if Sim.safari.state != .runningForeground { Sim.safari.activate() }
  }

  override func tearDown() {
    attach(self, name)
  }

  func median(_ v: [Double]) -> Double {
    let s = v.sorted()
    guard !s.isEmpty else { return -1 }
    return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
  }

  func num(_ r: Report?, _ k: String) -> Double { Double(r?.values[k] ?? "") ?? -1 }

  func list(_ v: [Double]) -> String { v.map { String(format: "%.1f", $0) }.joined(separator: ",") }

  func test01_StubCostWithoutInk() throws {
    Sim.safari.launch()
    var at: [Double] = [], own: [Double] = [], dcl: [Double] = []
    for i in 0..<Self.loads {
      let prev = Page.report()?.values["load"]
      Sim.safari.open(Sim.plainUrl("off.html?load=\(i)"))
      let r = Page.report(within: 15) {
        $0.values["load"] != prev && ($0.values["stubms"].map { $0 != "-1" } ?? false) && $0.int("dcl") >= 0
      }
      XCTAssertNotNil(r, "The stub did not run on load \(i) of a site without ink")
      at.append(num(r, "stubat"))
      own.append(num(r, "stubms"))
      dcl.append(num(r, "dcl"))
      XCTAssertEqual(r?.int("layer"), 0, "Something was added to a page without ink")
    }
    note(
      "timing_stub",
      String(
        format: "site without ink, %d loads, medians: stub starts %.1f ms after the first byte, stub's own work %.2f ms, DOMContentLoaded %.1f ms (starts %@)",
        Self.loads, median(at), median(own), median(dcl), list(at)))
    XCTAssertLessThan(median(own), 5, "The stub's own work is over its 5 ms budget")
  }

  func test02_InjectionWhenDrawModeTurnsOn() throws {
    var inj: [Double] = []
    for i in 0..<3 {
      let prev = Page.report()?.values["load"]
      Sim.safari.open(Sim.plainUrl("off.html?draw=\(i)"))
      XCTAssertNotNil(Page.report(within: 15) { $0.values["load"] != prev && $0.values["stubms"] != nil && $0.values["stubms"] != "-1" })
      XCTAssertTrue(Popup.setDraw(true), "Draw on this page did not turn on in the popup")
      let r = Page.report(within: 10) { $0.values["inj"] != nil && $0.values["inj"] != "-1" }
      inj.append(num(r, "inj"))
      XCTAssertTrue(Popup.setDraw(false), "Draw on this page did not turn off in the popup")
    }
    let got = inj.filter { $0 >= 0 }
    note(
      "timing_inject",
      got.isEmpty
        ? "draw mode on a site without ink: nothing was injected (the viewer and the tools were already in the content script)"
        : String(format: "draw mode on a site without ink: the background injected the viewer and the tools in %.1f ms (median of %@)", median(got), list(got)))
  }

  func test03_FirstInkWhereThereIsInk() throws {
    Page.currentPath = "sim.html"
    Page.open("sim.html")
    // Writes on the words when they have nothing yet, so this phase can run alone. Draw mode then
    // goes off, so only the viewer loads.
    if Marks.onWord(5).hits < 3 {
      XCTAssertTrue(Popup.setDraw(true))
      Marks.strokeWord(Page.report() ?? Report())
      XCTAssertGreaterThanOrEqual(Marks.onWord().hits, 3, "No ink on the words to time")
      Thread.sleep(forTimeInterval: 1.5)
    }
    XCTAssertTrue(Popup.setDraw(false))
    var fi: [Double] = [], at: [Double] = [], boots = 0
    for i in 0..<Self.loads {
      let prev = Page.report()?.values["load"]
      Page.reload()
      // The report of the new load, once its first ink mark is in.
      let r = Page.report(within: 15) {
        $0.values["load"] != prev && $0.int("layer") == 1 && $0.values["fi"] != nil && $0.values["fi"] != "-1"
      }
      XCTAssertNotNil(r, "No first ink mark on load \(i) of a page with ink")
      fi.append(num(r, "fi"))
      at.append(num(r, "stubat"))
      if (r?.int("boot") ?? 0) > 0 { boots += 1 }
    }
    note(
      "timing_ink",
      String(
        format: "page with ink, %d reloads, medians: first ink %.1f ms after the first byte, stub starts %.1f ms; registered viewer ran on %d of %d loads (first ink %@)",
        Self.loads, median(fi), median(at), boots, Self.loads, list(fi)))
  }
}
