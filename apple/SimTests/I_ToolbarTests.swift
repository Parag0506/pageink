import XCTest

/// Safari's toolbar shrunk after a scroll. With "Hide Tab Bar While Scrolling" on, which is how
/// a new simulator comes, Safari leaves a thin line with the address at the top and takes the
/// extension's button and Reload away. A reader taps that line to get them back. The setup
/// turns the setting off for the other phases; this one turns it on, checks that the popup and
/// Reload are still reached, that the app's guide says what to tap, and turns it off again.
final class I_ToolbarTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
  }

  override func tearDown() {
    attach(self, name)
  }

  var button: XCUIElement {
    Sim.safari.buttons.matching(NSPredicate(format: "label == %@", Sim.name)).firstMatch
  }

  /// One finger up the page with draw mode off, until Safari has shrunk its toolbar.
  func scrollUntilShrunk() -> Bool {
    for _ in 0..<3 where !Toolbar.shrunk {
      Touch.drag(CGPoint(x: 400, y: 900), CGPoint(x: 400, y: 400), velocity: .default)
      _ = waitFor(3) { Toolbar.shrunk }
    }
    return Toolbar.shrunk
  }

  func test01_PopupAndReloadAreReachedWithTheToolbarShrunk() throws {
    let on = TabBarSetting.set(true)
    Sim.settings.terminate()
    if on == .absent {
      note("shrunk", "no Hide Tab Bar While Scrolling switch on this system, so Safari keeps its toolbar")
      throw XCTSkip("This system has no Hide Tab Bar While Scrolling switch")
    }
    XCTAssertEqual(on, .set, "Hide Tab Bar While Scrolling could not be turned on")

    Sim.safari.launch()
    Page.currentPath = "off.html"
    Page.open("off.html")
    XCTAssertNotNil(Page.report(), "off.html did not load")
    XCTAssertTrue(Popup.setDraw(false), "The popup did not open with the toolbar in place")
    XCTAssertTrue(scrollUntilShrunk(), "Safari did not shrink its toolbar after a scroll, so this proves nothing")
    XCTAssertFalse(button.exists && button.isHittable, "The extension's button is still there with the toolbar shrunk")
    let scrolled = Page.report()?.int("sy") ?? 0
    XCTAssertGreaterThan(scrolled, 100)

    // The popup, the way a reader gets to it: a tap on the thin line, then the button.
    XCTAssertTrue(Popup.open(), "The popup did not open after Safari shrank its toolbar")
    XCTAssertTrue(Popup.drawSwitch.exists, "No Draw on this page switch in the popup")
    Popup.close()
    let kept = Page.report()?.int("sy") ?? 0
    XCTAssertGreaterThan(kept, 100, "Bringing the toolbar back sent the page to the top")

    // Reload, from its button.
    XCTAssertTrue(scrollUntilShrunk(), "Safari did not shrink its toolbar a second time")
    XCTAssertTrue(Toolbar.show(), "A tap on the thin line did not bring the toolbar back")
    let reload = Sim.safari.buttons["ReloadButton"]
    XCTAssertTrue(waitFor(5) { reload.exists && reload.isHittable }, "No Reload button after the toolbar came back")
    let load = Page.report()?.values["load"]
    Page.reload()
    XCTAssertNotNil(Page.report(within: 15) { $0.values["load"] != load }, "The page did not reload")
    note("shrunk", "after a scroll the toolbar is a thin line and the button is gone; a tap on the line brings it back (page stays at \(kept)), the popup opens and Reload works")
  }

  func test02_TheGuideSaysHowToGetTheButtonBack() throws {
    let app = Sim.app
    app.launchArguments = ["-InkPane", "setup"]
    app.launch()
    let line = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'tap the address at the top'")).firstMatch
    _ = line.waitForExistence(timeout: 10)
    line.reveal(in: app, tries: 4)
    XCTAssertTrue(line.exists, "The Set Up Safari screen does not say how to get the button back")
    XCTAssertTrue(line.label.contains(Sim.name) && line.label.contains("Draw on this page"), line.label)
    note("guide", "Set Up Safari says to tap the address at the top when Safari has shrunk its bar")
    attach(self, "setup guide")
    app.terminate()
  }

  func test03_PutTheSettingBack() throws {
    let off = TabBarSetting.set(false)
    Sim.settings.terminate()
    if off == .absent { throw XCTSkip("This system has no Hide Tab Bar While Scrolling switch") }
    XCTAssertEqual(off, .set, "Hide Tab Bar While Scrolling could not be turned off again")
  }
}
