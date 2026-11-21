import XCTest

/// Turns the extension on and allows it on every website, through the Settings app, the way
/// apple/README.md tells a reader to. Runs first. The classes run in name order.
final class A_SetupTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  func test01_EnableExtensionInSettings() throws {
    let s = Sim.settings
    // Settings > Apps > Safari > Extensions > (the extension)
    XCTAssertTrue(openSafariSettings(s), "Safari is not in Settings > Apps")
    // Safari shrinks its toolbar while a page scrolls, which hides the extension's button.
    // The tests keep the toolbar in place so the popup is always one tap away.
    let hide = s.switches["HIDE_BARS_WHEN_SCROLLING"].firstMatch.reveal(in: s, tries: 10)
    if hide.exists, (hide.value as? String) == "1" {
      hide.switches.firstMatch.exists ? hide.switches.firstMatch.tap() : hide.tap()
      _ = waitFor(5) { (hide.value as? String) == "0" }
    }
    note("toolbar", "Hide Tab Bar While Scrolling is \((hide.value as? String) == "0" ? "off" : "still on")")
    s.swipeDown()
    s.swipeDown()
    s.swipeDown()
    let ext = s.staticTexts["Extensions"].firstMatch.reveal(in: s)
    XCTAssertTrue(ext.isHittable, "No Extensions row in Settings > Apps > Safari")
    ext.tap()
    let row = s.buttons["\(Sim.appId).extension"]
    XCTAssertTrue(row.waitForExistence(timeout: 10), "The extension is not listed. Was the app installed and opened once?")
    row.tap()

    // Allow Extension, then All Websites: Allow.
    let allow = s.switches["Allow Extension"]
    XCTAssertTrue(allow.waitForExistence(timeout: 10))
    if (allow.value as? String) != "1" { allow.switches.firstMatch.tap() }
    XCTAssertTrue(waitFor(5) { (allow.value as? String) == "1" }, "Allow Extension did not turn on")
    let all = s.buttons["All Websites"].reveal(in: s)
    XCTAssertTrue(all.waitForExistence(timeout: 10), "No All Websites row once the extension is on")
    all.tap()
    // The choices are cells named by value: -1 Deny, 0 Ask, 1 Allow.
    let allowCell = s.cells["1"]
    XCTAssertTrue(allowCell.waitForExistence(timeout: 5))
    allowCell.tap()
    s.buttons["BackButton"].firstMatch.tap()
    XCTAssertTrue(s.buttons.matching(NSPredicate(format: "label == 'All Websites, Allow'")).firstMatch.waitForExistence(timeout: 5),
                  "All Websites is not set to Allow")
    note("enable", "Settings > Apps > Safari > Extensions > \(Sim.name): Allow Extension on, All Websites set to Allow")
    s.terminate()
  }
}
