import XCTest

/// Settings for the run. The name and the bundle id come from Config/PageInk.xcconfig through
/// Config/SimTests.plist, so a rename needs no change here. The port comes from the runner
/// script (TEST_RUNNER_INK_PORT).
enum Sim {
  static let info = Bundle(for: Marker.self).infoDictionary ?? [:]
  static let name = info["InkDisplayName"] as? String ?? ""
  static let appId = info["InkAppId"] as? String ?? ""
  static let port = ProcessInfo.processInfo.environment["INK_PORT"] ?? "8765"
  static let host = "127.0.0.1"
  static func url(_ path: String) -> URL { URL(string: "http://\(host):\(port)/\(path)")! }
  /// The same server under another host name, which has no ink: a site the reader never wrote on.
  static func plainUrl(_ path: String) -> URL { URL(string: "http://localhost:\(port)/\(path)")! }

  static let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
  static let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
  static var app: XCUIApplication { XCUIApplication(bundleIdentifier: appId) }
}

private final class Marker {}

/// One line per check in the log. run.sh collects them into the summary.
func note(_ check: String, _ text: String) {
  print("SIMNOTE \(check): \(text)")
}

extension XCUIElement {
  /// Scrolls the app until the element can be tapped.
  @discardableResult
  func reveal(in app: XCUIApplication, up: Bool = true, tries: Int = 8) -> XCUIElement {
    for _ in 0..<tries where !(exists && isHittable) {
      up ? app.swipeUp() : app.swipeDown()
    }
    return self
  }
}

/// Settings > Apps > Safari. The Apps list fills in slowly on a new simulator, so this waits,
/// scrolls, and falls back to the list's search field.
func openSafariSettings(_ s: XCUIApplication) -> Bool {
  s.terminate()
  s.launch()
  let apps = s.buttons["com.apple.settings.apps"]
  for _ in 0..<6 where !(apps.exists && apps.isHittable) {
    s.collectionViews["Sidebar"].swipeUp()
  }
  apps.tap()
  let safari = s.buttons["com.apple.mobilesafari"]
  _ = safari.waitForExistence(timeout: 10)
  safari.reveal(in: s, tries: 10)
  if !(safari.exists && safari.isHittable) {
    let search = s.searchFields["Search Apps"].firstMatch
    if search.waitForExistence(timeout: 5) {
      search.tap()
      search.typeText("Safari")
    }
    _ = safari.waitForExistence(timeout: 10)
  }
  guard safari.exists && safari.isHittable else { return false }
  safari.tap()
  return true
}

/// Settings > Apps > Safari > Extensions > the extension > All Websites. The choices are cells
/// named by value: -1 Deny, 0 Ask, 1 Allow. `word` is how the row then reads, such as "Allow".
@discardableResult
func setAllWebsites(_ value: String, _ word: String) -> Bool {
  let s = Sim.settings
  guard openSafariSettings(s) else { return false }
  s.swipeDown()
  s.swipeDown()
  s.swipeDown()
  let ext = s.staticTexts["Extensions"].firstMatch.reveal(in: s)
  guard ext.isHittable else { return false }
  ext.tap()
  let row = s.buttons["\(Sim.appId).extension"]
  guard row.waitForExistence(timeout: 10) else { return false }
  row.tap()
  let all = s.buttons["All Websites"].reveal(in: s)
  guard all.waitForExistence(timeout: 10) else { return false }
  all.tap()
  let cell = s.cells[value]
  guard cell.waitForExistence(timeout: 5) else { return false }
  cell.tap()
  s.buttons["BackButton"].firstMatch.tap()
  let ok = s.buttons.matching(NSPredicate(format: "label == %@", "All Websites, \(word)")).firstMatch
    .waitForExistence(timeout: 5)
  s.terminate()
  return ok
}

func waitFor(_ timeout: TimeInterval = 10, poll: TimeInterval = 0.25, _ cond: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(timeout)
  repeat {
    if cond() { return true }
    Thread.sleep(forTimeInterval: poll)
  } while Date() < end
  return cond()
}

// MARK: - The page's own report

/// What report.js on the fixture pages shows: one line of key=value pairs.
struct Report {
  var values: [String: String] = [:]
  /// Where the report line is on screen, to map page coordinates to screen points.
  var frame: CGRect = .zero

  func int(_ k: String) -> Int { Int(values[k] ?? "") ?? -1 }
  func rect(_ k: String) -> CGRect? {
    let p = (values[k] ?? "").split(separator: ",").compactMap { Double($0) }
    guard p.count == 4 else { return nil }
    return CGRect(x: p[0], y: p[1], width: p[2], height: p[3])
  }
  /// Screen point for a point in the page's viewport. The report line sits at the viewport's
  /// top left, so its screen frame gives the offset. Pages use width=device-width: scale 1.
  func screen(_ p: CGPoint) -> CGPoint {
    let me = rect("me") ?? .zero
    return CGPoint(x: frame.minX - me.minX + p.x, y: frame.minY - me.minY + p.y)
  }
  /// The marker words on screen.
  var word: CGRect? {
    guard let w = rect("w"), frame.minX.isFinite, frame.minY.isFinite else { return nil }
    let o = screen(w.origin)
    return CGRect(origin: o, size: w.size)
  }
}

enum Page {
  static var web: XCUIElement { Sim.safari.webViews.firstMatch }

  static func open(_ path: String) {
    Sim.safari.open(Sim.url(path))
    _ = waitFor(15) { report() != nil }
  }

  static func report() -> Report? {
    let el = Sim.safari.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'report '")).firstMatch
    guard el.exists else { return nil }
    let label = el.label
    guard label.hasSuffix(" end") else { return nil }
    var r = Report()
    r.frame = el.frame
    for part in label.split(separator: " ") {
      let kv = part.split(separator: "=", maxSplits: 1)
      if kv.count == 2 { r.values[String(kv[0])] = String(kv[1]) }
    }
    return r
  }

  /// A fresh report once a condition on it holds.
  static func report(within t: TimeInterval = 10, where cond: (Report) -> Bool) -> Report? {
    var last: Report?
    _ = waitFor(t) {
      last = report()
      return last.map(cond) ?? false
    }
    return last.flatMap { cond($0) ? $0 : nil }
  }

  static func reload() {
    let b = Sim.safari.buttons["ReloadButton"]
    if b.exists && b.isHittable { b.tap() } else { Sim.safari.open(Sim.url(currentPath ?? "sim.html")) }
  }

  static var currentPath: String?

  /// Scrolls the page to the top with the page's own button when the marker words are out
  /// of view. The button is a control, so a tap on it reaches the page even in draw mode.
  static func showWords() {
    guard let r = report(), let w = r.word else { return }
    let view = web.frame
    if w.minY > view.minY + 140 && w.maxY < view.maxY - 140 { return }
    let top = Sim.safari.webViews.buttons["Scroll to top"].firstMatch
    if top.exists { top.tap() }
    _ = report(within: 5) { $0.int("sy") == 0 }
  }
}

// MARK: - Touches

enum Touch {
  static func point(_ p: CGPoint) -> XCUICoordinate {
    Sim.safari.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: p.x, dy: p.y))
  }

  /// One finger, down at a, along to b, then up. A short press, so it is not a long press.
  static func drag(_ a: CGPoint, _ b: CGPoint, velocity: XCUIGestureVelocity = .slow) {
    point(a).press(forDuration: 0.05, thenDragTo: point(b), withVelocity: velocity, thenHoldForDuration: 0.05)
  }

  static func tap(_ p: CGPoint) { point(p).tap() }

  static var orientation: Int64 {
    switch XCUIDevice.shared.orientation {
    case .landscapeLeft: return 4  // UIInterfaceOrientation.landscapeRight
    case .landscapeRight: return 3
    case .portraitUpsideDown: return 2
    default: return 1
    }
  }

  /// Two fingers side by side, moved together by dy. Throws when XCTest cannot do it.
  static func twoFingers(at p: CGPoint, dy: CGFloat, duration: TimeInterval = 0.6) throws {
    let paths: [[NSValue]] = [-30, 30].map { dx in
      (0...10).map { i in
        NSValue(cgPoint: CGPoint(x: p.x + dx, y: p.y + dy * CGFloat(i) / 10))
      }
    }
    var error: NSError?
    if !SynthTouches(paths, duration, orientation, &error) {
      throw error ?? NSError(domain: "SimTests", code: 2, userInfo: [NSLocalizedDescriptionKey: "Two fingers failed."])
    }
  }
}

// MARK: - Screenshots

/// A screenshot as pixels, read in screen points.
struct Shot {
  let width: Int
  let height: Int
  let scale: CGFloat
  private let data: [UInt8]

  /// The device turn when the shot was taken. The image itself is always upright portrait.
  let turn: UIDeviceOrientation
  /// Portrait width and height in points.
  let pw: CGFloat
  let ph: CGFloat

  init(_ image: UIImage = XCUIScreen.main.screenshot().image) {
    let cg = image.cgImage!
    width = cg.width
    height = cg.height
    // No query to Safari here: a page whose accessibility is not loaded would stall it.
    scale = UIScreen.main.scale
    pw = CGFloat(cg.width) / scale
    ph = CGFloat(cg.height) / scale
    turn = XCUIDevice.shared.orientation
    var buf = [UInt8](repeating: 0, count: width * height * 4)
    let ctx = CGContext(
      data: &buf, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    data = buf
  }

  /// A point in the interface's coordinates (what element frames use) to a pixel in the image.
  func pixel(_ p: CGPoint) -> (Int, Int)? {
    guard p.x.isFinite, p.y.isFinite else { return nil }
    let q: CGPoint
    switch turn {
    case .landscapeLeft: q = CGPoint(x: pw - p.y, y: p.x)
    case .landscapeRight: q = CGPoint(x: p.y, y: ph - p.x)
    case .portraitUpsideDown: q = CGPoint(x: pw - p.x, y: ph - p.y)
    default: q = p
    }
    let x = q.x * scale
    let y = q.y * scale
    guard abs(x) < 100_000, abs(y) < 100_000 else { return nil }
    return (Int(x), Int(y))
  }

  func rgb(_ px: Int, _ py: Int) -> (Int, Int, Int)? {
    guard px >= 0, py >= 0, px < width, py < height else { return nil }
    let i = (py * width + px) * 4
    return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
  }

  /// The first pen colour is dark blue (#1f2a44). The fixture text is grey, so blue wins.
  static func isInk(_ c: (Int, Int, Int)) -> Bool {
    let (r, g, b) = c
    return b - r >= 20 && b - g >= 10 && b < 170
  }

  /// Pen marks within `radius` points of p.
  func ink(near p: CGPoint, radius: CGFloat = 4) -> Bool {
    let r = Int(radius)
    for dy in -r...r {
      for dx in -r...r {
        guard let (x, y) = pixel(CGPoint(x: p.x + CGFloat(dx), y: p.y + CGFloat(dy))) else { continue }
        for oy in 0..<Int(scale) {
          for ox in 0..<Int(scale) {
            if let c = rgb(x + ox, y + oy), Shot.isInk(c) { return true }
          }
        }
      }
    }
    return false
  }

  /// How many sampled points in a rectangle (in points) have ink, one sample per point.
  func inkCount(in rect: CGRect) -> Int {
    guard rect.width.isFinite, rect.height.isFinite, rect.width < 5000, rect.height < 5000 else { return 0 }
    var n = 0
    for y in stride(from: rect.minY, through: rect.maxY, by: 1) {
      for x in stride(from: rect.minX, through: rect.maxX, by: 1) {
        if let (px, py) = pixel(CGPoint(x: x, y: y)), let c = rgb(px, py), Shot.isInk(c) { n += 1 }
      }
    }
    return n
  }

  /// How many sampled points in a rectangle are dark grey or black, like printed text.
  func textCount(in rect: CGRect) -> Int {
    var n = 0
    for y in stride(from: rect.minY, through: rect.maxY, by: 2) {
      for x in stride(from: rect.minX, through: rect.maxX, by: 2) {
        if let (px, py) = pixel(CGPoint(x: x, y: y)), let (r, g, b) = rgb(px, py),
          r < 90, abs(r - g) < 12, abs(r - b) < 12
        {
          n += 1
        }
      }
    }
    return n
  }

  /// Of five points along the middle of a word box, how many have ink on them.
  func inkOn(word: CGRect) -> Int {
    (1...5).filter { i in
      ink(near: CGPoint(x: word.minX + word.width * CGFloat(i) / 6, y: word.midY))
    }.count
  }
}

func attach(_ test: XCTestCase, _ name: String) {
  let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
  a.name = name
  a.lifetime = .keepAlways
  test.add(a)
}

// MARK: - The extension's popup

/// The popup is reached from the extension's button in Safari's toolbar. Its web view is
/// in Safari's accessibility tree, so the test taps it like a reader would.
enum Popup {
  static var drawSwitch: XCUIElement {
    Sim.safari.webViews.switches.matching(
      NSPredicate(format: "label == 'Draw on this page' OR label == 'Drawing on'")
    ).firstMatch
  }

  @discardableResult
  static func open() -> Bool {
    if drawSwitch.exists { return true }
    let b = Sim.safari.buttons.matching(NSPredicate(format: "label == %@", Sim.name)).firstMatch
    if !b.waitForExistence(timeout: 10) { return false }
    b.tap()
    return drawSwitch.waitForExistence(timeout: 10)
  }

  static func close() {
    let d = Sim.safari.otherElements["PopoverDismissRegion"]
    // The extension's button toggles its popup. It is in the toolbar, so a tap there never
    // reaches the page, where a finger in draw mode would leave a dot.
    let b = Sim.safari.buttons.matching(NSPredicate(format: "label == %@", Sim.name)).firstMatch
    // With the popup up the button is not hittable, so it is tapped by its place on screen.
    for i in 0..<4 where drawSwitch.exists {
      if i % 2 == 0, b.exists, !b.frame.isEmpty {
        Touch.point(CGPoint(x: b.frame.midX, y: b.frame.midY)).tap()
      } else if d.exists {
        d.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.02)).tap()
      }
      if waitFor(3, { !drawSwitch.exists }) { return }
    }
  }

  /// Turns draw mode on or off through the popup. True when the popup shows the wanted state.
  @discardableResult
  static func setDraw(_ on: Bool) -> Bool {
    guard open() else { return false }
    let want = on ? "1" : "0"
    // The switch is enabled once the popup has heard from the page.
    _ = waitFor(5) { drawSwitch.isEnabled }
    if (drawSwitch.value as? String) != want { drawSwitch.tap() }
    let ok = waitFor(8) { (drawSwitch.value as? String) == want }
    close()
    return ok
  }

  /// The popup's note count line, such as "1 note on this page".
  static func notes() -> String {
    guard open() else { return "no popup" }
    let t = Sim.safari.webViews.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'on this page'")).firstMatch
    _ = t.waitForExistence(timeout: 5)
    let s = t.exists ? t.label : "no count"
    close()
    return s
  }
}

// MARK: - Marks on the marker words

enum Marks {
  /// One finger across the marker words, a little past both ends.
  @discardableResult
  static func strokeWord(_ r: Report) -> CGRect? {
    // A fresh report: the one passed in may be from before the popup opened.
    guard let w = (Page.report(within: 5) { $0.word != nil } ?? r).word else { return nil }
    Touch.drag(CGPoint(x: w.minX - 10, y: w.midY), CGPoint(x: w.maxX + 10, y: w.midY + 1))
    return w
  }

  /// Waits until the marker words have ink on at least 3 of 5 points. Returns the best count.
  static func onWord(_ timeout: TimeInterval = 8) -> (hits: Int, word: CGRect?) {
    var best = 0
    var word: CGRect?
    Page.showWords()
    _ = waitFor(timeout, poll: 0.5) {
      guard let r = Page.report(), let w = r.word else { return false }
      word = w
      best = max(best, Shot().inkOn(word: w))
      return best >= 3
    }
    return (best, word)
  }
}

// MARK: - How the viewer came

enum Viewer {
  /// Whether the registered viewer ran at the start of this load (the bench mark ink:boot), or
  /// the stub had it injected.
  static func how() -> String {
    guard let r = Page.report() else { return "no report" }
    return r.int("boot") > 0 ? "the registered viewer ran at document start" : "the viewer was injected on request"
  }
}
