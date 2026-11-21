import XCTest

/// Safari's "All Websites" left on Ask. The Pencil then writes only after a tap on the toolbar
/// button, so the popup and the app's setup screen must both say what to change. Runs last: it
/// sets Ask and puts Allow back.
final class E_SiteAccessTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
  }

  override func tearDown() {
    attach(self, name)
  }

  static let ask = "\(Sim.name) needs permission for websites. Tap this, then choose Always Allow on Every Website."

  var accessLine: XCUIElement {
    Sim.safari.webViews.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(Sim.name) needs permission")).firstMatch
  }

  /// With Ask, Safari takes the extension's button out of the address bar. The reader then finds
  /// it in the page menu, at the left of the address bar.
  func openFromPageMenu() -> Bool {
    if Popup.open() { return true }
    let safari = Sim.safari
    let menu = safari.buttons.matching(NSPredicate(
      format: "identifier == 'PageFormatMenuButton' OR label CONTAINS[c] 'Page Menu' OR label CONTAINS[c] 'Page Settings' OR label CONTAINS[c] 'Reader'"
    )).firstMatch
    guard menu.waitForExistence(timeout: 5) else { return false }
    menu.tap()
    // A new Safari shows a first-run card in this menu. It is not part of what is tested.
    let notNow = safari.buttons["Not Now"].firstMatch
    if notNow.waitForExistence(timeout: 3) { notNow.tap() }
    attach(self, "page menu")
    let named = NSPredicate(format: "label == %@ OR label BEGINSWITH %@", Sim.name, "\(Sim.name),")
    var item = safari.buttons.matching(named).firstMatch
    if !item.waitForExistence(timeout: 3) {
      // The extensions may sit behind the menu's More button.
      let more = safari.buttons.matching(NSPredicate(format: "label == 'More' OR identifier == 'MoreButton'")).firstMatch
      if more.exists { more.tap() }
      // The full Page Menu lists the extensions under the page and tab actions.
      item = safari.descendants(matching: .any).matching(named).firstMatch
      for _ in 0..<6 where !(item.exists && item.isHittable) {
        // Swiped on a section header, so no row is tapped by mistake.
        let header = safari.staticTexts["Tab Actions"].firstMatch
        if header.exists { header.swipeUp(velocity: .fast) } else { safari.staticTexts["Page Actions"].firstMatch.swipeUp() }
      }
      attach(self, "page menu, more")
      guard item.exists && item.isHittable else { return false }
    }
    item.tap()
    // With Ask, Safari may first ask about this site. The popup is what is tested, not the choice.
    attach(self, "after tapping the extension")
    return Popup.drawSwitch.waitForExistence(timeout: 10)
  }

  /// The setup screen's check for every website, in the app.
  func appStatus() -> String {
    let app = Sim.app
    app.launchArguments = ["-InkPane", "setup"]
    app.launch()
    let status = app.staticTexts.matching(NSPredicate(
      format: "label BEGINSWITH 'Every website is' OR label BEGINSWITH 'Not yet.' OR label BEGINSWITH 'Not checked yet'"
    )).firstMatch
    var label = ""
    // The app looks again every two seconds.
    _ = waitFor(10) {
      if !status.exists { _ = status.reveal(in: app, up: true, tries: 2) }
      label = status.exists ? status.label : ""
      return !label.isEmpty && !label.hasPrefix("Not checked")
    }
    attach(self, "setup screen: \(label)")
    app.terminate()
    return label
  }

  func test01_AllowedShowsNoLineAndTheAppSaysDone() throws {
    Sim.safari.launch()
    Page.open("off.html")
    XCTAssertTrue(Popup.open(), "The popup did not open")
    Thread.sleep(forTimeInterval: 2)
    XCTAssertFalse(accessLine.exists, "The popup asks for website access although All Websites is Allow")
    Popup.close()
    let label = appStatus()
    XCTAssertEqual(label, "Every website is allowed", "The setup screen does not see Allow")
    note("access", "All Websites on Allow: no line in the popup; the app says \"\(label)\"")
  }

  func test02_AskIsSeenByTheApp() throws {
    XCTAssertTrue(setAllWebsites("0", "Ask"), "Could not set All Websites to Ask")
    Sim.safari.launch()
    Page.open("off.html")
    // Safari runs the background when it starts; it tells the app.
    Thread.sleep(forTimeInterval: 3)
    let label = appStatus()
    XCTAssertTrue(label.hasPrefix("Not yet"), "The setup screen does not see Ask: \(label)")
    note("access", "All Websites on Ask: the app says \"\(label)\"")
  }

  func test03_AskShowsWhatToTapInThePopup() throws {
    Sim.safari.activate()
    guard openFromPageMenu() else {
      // Safari takes the toolbar button away with Ask, and its Page Menu sheet does not always let
      // the test reach the extension. The words are checked in the extension's own tests.
      note("access", "All Websites on Ask: the test could not reach the popup through the Page Menu")
      throw XCTSkip("The popup could not be reached through Safari's Page Menu")
    }
    XCTAssertTrue(accessLine.waitForExistence(timeout: 10), "The popup does not say that website access is missing")
    XCTAssertEqual(accessLine.label, Self.ask)
    note("access", "All Websites on Ask: the popup says \"\(accessLine.label)\"")
    accessLine.tap()
    // Safari asks in its own sheet. Take its widest choice when it offers one.
    let every = Sim.safari.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Every Website'")).firstMatch
    if every.waitForExistence(timeout: 5) {
      attach(self, "Safari asks")
      every.tap()
      note("access", "the line brought up Safari's question; Every Website was chosen")
    } else {
      note("access", "the line did not bring up a Safari sheet; it now reads \"\(accessLine.exists ? accessLine.label : "nothing")\"")
    }
    Popup.close()
  }

  func test04_PutAllowBack() throws {
    XCTAssertTrue(setAllWebsites("1", "Allow"), "Could not set All Websites back to Allow")
  }
}
