import XCTest

/// Turns the extension on and allows it on every website, through the Settings app, the way
/// apple/README.md tells a reader to. Runs first. The classes run in name order.
final class A_SetupTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  func test01_EnableExtensionInSettings() throws {
    let s = Sim.settings
    // Safari shrinks its toolbar while a page scrolls, which hides the extension's button.
    // The tests keep the toolbar in place so the popup is always one tap away. The switch is
    // read again in a Settings app opened anew, so "off" here is what Safari will see.
    switch TabBarSetting.set(false, in: s) {
    case .set:
      note("toolbar", "Hide Tab Bar While Scrolling is off, as read in Settings opened anew")
    case .absent:
      // Nothing to turn off. The tests bring a shrunk toolbar back themselves (Toolbar.show).
      XCTAssertTrue(openSafariSettings(s), "Safari is not in Settings > Apps")
      note("toolbar", "Settings > Apps > Safari has no Hide Tab Bar While Scrolling switch on this system")
    case .stuck(let seen):
      XCTFail("Hide Tab Bar While Scrolling could not be turned off in Settings > Apps > Safari: \(seen)")
    }
    // Settings > Apps > Safari > Extensions > (the extension). Every tap on the way is checked
    // and made again when nothing came of it: a tap on a page that has just opened can be lost.
    if let missing = openExtensionPage(s) { XCTFail(missing) }

    // Allow Extension, then All Websites: Allow.
    XCTAssertTrue(s.switches["Allow Extension"].turn(true), "Allow Extension did not turn on after three taps")
    XCTAssertTrue(chooseAllWebsites("1", "Allow", in: s), "All Websites could not be set to Allow once the extension was on")
    note("enable", "Settings > Apps > Safari > Extensions > \(Sim.name): Allow Extension on, All Websites set to Allow")
    s.terminate()
  }
}
