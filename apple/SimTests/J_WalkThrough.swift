import XCTest

/// The walk of a first-time reader from start to end, made to be filmed: open the app, turn the
/// extension on in Settings, write on a web page in Safari, reload it, and find the page in the
/// app's Notes. apple/device/walk.sh runs it on a real iPad, or on a simulator, with the screen
/// recorded.
///
/// It runs only when the runner passes TEST_RUNNER_INK_WALK=1, so the simulator suite skips it.
///
/// It changes two things on the iPad, both of which a reader sets by hand anyway: the extension
/// is turned on, and All Websites is set to Allow. In Safari it opens the page in a tab of its
/// own. The strokes are one finger with Draw on: XCTest has no pen.
final class J_WalkThrough: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// A moment for the viewer of the film to read the screen.
  private func rest(_ seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }

  /// One finger through the points, in screen points, over the given time.
  private func stroke(_ points: [CGPoint], _ seconds: TimeInterval) throws {
    var error: NSError?
    if !SynthTouches([points.map { NSValue(cgPoint: $0) }], seconds, Touch.orientation, &error) {
      throw error ?? NSError(domain: "SimTests", code: 3, userInfo: [NSLocalizedDescriptionKey: "The stroke was not made."])
    }
    // Less than the 1.5 s that starts a new note, so the strokes of one shape stay together.
    rest(0.5)
  }

  /// Draw on or off from the popup, slowly enough to be seen. The switch is a row of the popup's
  /// web view. When XCTest cannot tell that the row can be tapped, the tap goes to the place of
  /// its knob.
  private func setDraw(_ on: Bool) -> Bool {
    guard Popup.open() else { return false }
    let sw = Popup.drawSwitch
    let want = on ? "1" : "0"
    // The switch is enabled once the popup has heard from the page.
    _ = waitFor(6) { sw.isEnabled }
    rest(1.5)
    for _ in 0..<3 where (sw.value as? String) != want {
      if sw.isHittable {
        sw.tap()
      } else {
        sw.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
      }
      _ = waitFor(4) { (sw.value as? String) == want }
    }
    let ok = (sw.value as? String) == want
    rest(1.2)
    Popup.close()
    return ok
  }

  /// Before a take: the extension off again, so the film shows it being turned on.
  /// apple/device/walk.sh runs it by name when INK_WALK_RESET=1.
  func test00_ExtensionOff() throws {
    guard ProcessInfo.processInfo.environment["INK_WALK"] == "1" else { throw XCTSkip("Only for the filmed walk") }
    let s = Sim.settings
    XCTAssertTrue(openSafariSettings(s), "Safari is not in Settings > Apps")
    if let missing = openExtensionPage(s) { XCTFail(missing) }
    XCTAssertTrue(s.switches["Allow Extension"].turn(false), "Allow Extension did not turn off")
    // Another copy of the extension, from an older build with another bundle id, would write
    // on the same pages and keep its notes for its own app. Turn every such copy off too.
    let mine = "\(Sim.appId).extension"
    let back = s.buttons["BackButton"].firstMatch
    for _ in 0..<4 {
      back.tap(until: { s.buttons[mine].exists })
      let others = s.buttons.matching(NSPredicate(format: "identifier ENDSWITH '.extension' AND identifier != %@ AND label CONTAINS %@", mine, Sim.name))
      var turned = false
      for i in 0..<others.count {
        let row = others.element(boundBy: i)
        guard row.exists, row.label.hasSuffix("On") || (row.value as? String) == "On" || row.label.contains(", On") else { continue }
        let allow = s.switches["Allow Extension"]
        // Read now: the row is gone from the screen once its page is open.
        let which = row.identifier
        guard row.tap(until: { allow.exists }, wait: 10) else { continue }
        XCTAssertTrue(allow.turn(false), "Another copy of the extension did not turn off")
        note("walk", "turned off another copy of the extension: \(which)")
        turned = true
        break
      }
      if !turned { break }
    }
    s.terminate()
    Sim.app.terminate()
  }

  func test01_FirstUse() throws {
    let env = ProcessInfo.processInfo.environment
    guard env["INK_WALK"] == "1" else { throw XCTSkip("Only for the filmed walk (apple/device/walk.sh)") }
    let address = env["INK_WALK_URL"] ?? "https://en.wikipedia.org/wiki/Honey_bee"
    guard let url = URL(string: address) else { return XCTFail("INK_WALK_URL is not an address: \(address)") }

    // 1. The film begins with opening the app. On a first start it shows the setup steps.
    XCUIDevice.shared.press(.home)
    rest(1.5)
    let app = Sim.app
    app.launch()
    let setup = app.buttons["Set Up Safari"].firstMatch
    if setup.waitForExistence(timeout: 10), setup.isHittable { setup.tap() }
    rest(5)

    // 2. Settings > Apps > Safari > Extensions > the extension: on, and allowed on every website.
    let s = Sim.settings
    XCTAssertTrue(openSafariSettings(s), "Safari is not in Settings > Apps")
    if let missing = openExtensionPage(s) { XCTFail(missing) }
    rest(1.5)
    XCTAssertTrue(s.switches["Allow Extension"].turn(true), "Allow Extension did not turn on")
    rest(1)
    // Settings says so when another extension has the same keyboard shortcut, such as a copy
    // of this one from another device. It is a notice with one button.
    let notice = s.buttons["OK"].firstMatch
    if notice.waitForExistence(timeout: 3) {
      rest(2.5)
      notice.tap()
      rest(1)
    }
    XCTAssertTrue(chooseAllWebsites("1", "Allow", in: s), "All Websites could not be set to Allow")
    rest(2.5)

    // 3. A web page in Safari.
    let safari = Sim.safari
    safari.activate()
    safari.open(url)
    let web = Page.web
    XCTAssertTrue(web.waitForExistence(timeout: 30), "Safari shows no page")
    rest(6)
    // The first-run guide opens once per install, in a tab of its own. Let it be read, then
    // go back to the page.
    if Guide.inFront {
      rest(5)
      safari.open(url)
      _ = web.waitForExistence(timeout: 30)
      rest(5)
    }

    // 4. Draw on, from the extension's button in Safari's toolbar.
    XCTAssertTrue(setDraw(true), "Draw did not turn on from the popup")
    rest(1.5)

    // 5. Write: a ring round some words, a wavy line under a row, a tick and a short word.
    let f = web.frame
    func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: f.minX + f.width * x, y: f.minY + f.height * y) }
    let ring: [CGPoint] = (0...40).map { i in
      let a = CGFloat(i) / 36 * 2 * .pi - .pi / 2
      let c = at(0.30, 0.36)
      return CGPoint(x: c.x + cos(a) * f.width * 0.13, y: c.y + sin(a) * 26)
    }
    try stroke(ring, 1.4)
    rest(1.8)
    let wave: [CGPoint] = (0...48).map { i in
      let t = CGFloat(i) / 48
      let p = at(0.10 + 0.42 * t, 0.55)
      return CGPoint(x: p.x, y: p.y + sin(t * 10 * .pi) * 3)
    }
    try stroke(wave, 1.2)
    rest(1.8)
    // A tick, then "ok" beside it, in the free space on the right.
    let o = at(0.66, 0.50)
    try stroke([CGPoint(x: o.x, y: o.y + 18), CGPoint(x: o.x + 14, y: o.y + 36), CGPoint(x: o.x + 46, y: o.y - 14)], 0.5)
    let oh: [CGPoint] = (0...24).map { i in
      let a = CGFloat(i) / 22 * 2 * .pi - .pi / 2
      return CGPoint(x: o.x + 86 + cos(a) * 15, y: o.y + 18 + sin(a) * 19)
    }
    try stroke(oh, 0.6)
    try stroke([CGPoint(x: o.x + 116, y: o.y - 16), CGPoint(x: o.x + 116, y: o.y + 37)], 0.35)
    try stroke([CGPoint(x: o.x + 144, y: o.y + 4), CGPoint(x: o.x + 118, y: o.y + 20), CGPoint(x: o.x + 146, y: o.y + 37)], 0.45)
    rest(3)
    attach(self, "written")

    // 6. Reload. The ink comes back on the same words.
    Toolbar.show()
    let reload = safari.buttons["ReloadButton"].firstMatch
    if reload.exists && reload.isHittable { reload.tap() } else { safari.open(url) }
    rest(7)
    attach(self, "after reload")

    // 7. Draw off, and the page scrolls with its ink.
    XCTAssertTrue(setDraw(false), "Draw did not turn off from the popup")
    rest(1)
    let from = web.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.7))
    let to = web.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45))
    from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
    rest(1.5)
    to.press(forDuration: 0.05, thenDragTo: from, withVelocity: .slow, thenHoldForDuration: 0.3)
    rest(2)

    // 8. Back in the app: the setup checks, then the page in Notes.
    app.activate()
    rest(4)
    let notes = app.buttons["Notes"].firstMatch
    if notes.waitForExistence(timeout: 10), notes.isHittable { notes.tap() }
    rest(6)
    attach(self, "notes in the app")
  }
}
