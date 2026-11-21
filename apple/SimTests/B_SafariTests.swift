import XCTest

/// The extension in Mobile Safari, driven like a reader with one finger. The tests run in
/// order and build on each other: the ink written in test 02 is the ink later tests look for.
final class B_SafariTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
    if Sim.safari.state != .runningForeground { Sim.safari.activate() }
  }

  override func tearDown() {
    attach(self, name)
  }

  func open(_ path: String) -> Report {
    Page.currentPath = path
    Page.open(path)
    guard let r = Page.report() else {
      XCTFail("\(path) did not load from the Mac at \(Sim.url(path))")
      return Report()
    }
    return r
  }

  func test01_StubLoadsAndAddsNothing() throws {
    Sim.safari.launch()
    let r0 = open("off.html")
    // Give the stub time to read storage and decide. A page without ink stays as it is.
    let r = Page.report(within: 10) { $0.int("stub") >= 1 } ?? r0
    XCTAssertGreaterThanOrEqual(r.int("stub"), 1, "The stub did not run: no ink:stub measure on the page")
    Thread.sleep(forTimeInterval: 2)
    XCTAssertEqual(Page.report()?.int("layer"), 0, "Something was added to a page without ink")
    note("stub", "stub measured \(r.int("stub")) time(s), no ink-layer on a page without ink")
  }

  func test02_OneFingerWritesInDrawMode() throws {
    let r = open("sim.html")
    XCTAssertTrue(Popup.setDraw(true), "Draw on this page did not turn on in the popup")
    XCTAssertNotNil(Marks.strokeWord(r))
    let (hits, _) = Marks.onWord()
    XCTAssertGreaterThanOrEqual(hits, 3, "No ink on the marker words after a one-finger stroke (\(hits)/5 points)")
    XCTAssertEqual(Page.report(within: 5) { $0.int("layer") == 1 }?.int("layer"), 1, "No ink-layer after writing")
    note("draw", "one finger stroke: ink on \(hits)/5 points of the words")
  }

  func test03_BarHasTouchSizesAndLeavesControlsFree() throws {
    // Writing wakes the bar. A tiny stroke in the margin keeps the test from waiting on it.
    _ = Page.report()
    let labels = ["Draw", "Pen, first colour", "Pen, second colour", "Highlighter", "Eraser", "Lasso", "Undo", "Redo", "More"]
    let web = Sim.safari.webViews.firstMatch
    var found: [String: CGRect] = [:]
    _ = waitFor(5) {
      for l in labels {
        // Toggle buttons show up as switches and the menu button as a pop-up button.
        let b = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", l)).firstMatch
        if b.exists { found[l] = b.frame }
      }
      return found.count == labels.count
    }
    if found.count < labels.count {
      // Wakes a bar that hid itself, then looks again.
      let handle = web.descendants(matching: .any).matching(NSPredicate(format: "label == 'Show ink tools'")).firstMatch
      if handle.exists { handle.tap() }
      _ = waitFor(5) {
        for l in labels {
          let b = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", l)).firstMatch
          if b.exists { found[l] = b.frame }
        }
        return found.count == labels.count
      }
    }
    XCTAssertEqual(found.count, labels.count, "Bar buttons not found: \(labels.filter { found[$0] == nil })")
    let small = found.filter { $0.value.width < 43.5 || $0.value.height < 43.5 }
    XCTAssertTrue(small.isEmpty, "Bar buttons under 44 points: \(small.map { "\($0.key) \($0.value.size)" })")
    let candidates: [XCUIElement] = [
      web.links["Jump to the notes"].firstMatch, web.buttons["A button"].firstMatch, web.textFields.firstMatch,
    ]
    let controls: [CGRect] = candidates.filter { $0.exists }.map { $0.frame }
    let covered = found.filter { b in controls.contains { $0.intersects(b.value) } }
    XCTAssertTrue(covered.isEmpty, "The bar covers the page's controls: \(covered.keys)")
    let bar = found.values.reduce(CGRect.null) { $0.union($1) }
    note("bar", "\(found.count) buttons, smallest \(Int(found.values.map { min($0.width, $0.height) }.min() ?? 0)) pt, bar at \(bar.integral)")
  }

  func test04_TrayOpens() throws {
    // A note whose words are gone has nowhere to go, so it waits in the tray.
    let r = open("moving.html")
    XCTAssertTrue(Popup.setDraw(true))
    Marks.strokeWord(r)
    XCTAssertGreaterThanOrEqual(Marks.onWord().hits, 3, "No ink on the words of the moving page")
    Thread.sleep(forTimeInterval: 1.5)
    Page.currentPath = "moving.html#gone"
    Sim.safari.open(Sim.url("moving.html#gone"))
    Page.reload()
    XCTAssertNotNil(Page.report(within: 10) { $0.values["w"] == "-" }, "The marker words are still on the page")
    // The tray button sits on the bar, which comes with draw mode.
    XCTAssertTrue(Popup.setDraw(true))
    let web = Sim.safari.webViews
    let tray = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Moved notes,'")).firstMatch
    XCTAssertTrue(tray.waitForExistence(timeout: 10), "No tray button with a count on the bar")
    let label = tray.label
    tray.tap()
    let close = web.descendants(matching: .any).matching(NSPredicate(format: "label == 'Close'")).firstMatch
    XCTAssertTrue(close.waitForExistence(timeout: 5), "The tray did not open")
    let empty = web.staticTexts["No moved notes."].firstMatch
    XCTAssertFalse(empty.exists && empty.isHittable, "The tray opened but shows no notes")
    close.tap()
    note("tray", "the bar shows \(label); the tray opens with the note in it")
  }

  func test05_TwoFingersScrollInDrawMode() throws {
    _ = open("sim.html")
    Page.showWords()
    let before = Page.report()?.int("sy") ?? -1
    let notes0 = Popup.notes()
    XCTAssertTrue(Popup.setDraw(true))
    try Touch.twoFingers(at: CGPoint(x: 400, y: 900), dy: -350)
    let after = Page.report(within: 5) { $0.int("sy") > before + 100 }
    XCTAssertNotNil(after, "Two fingers did not scroll in draw mode (scrollY \(before) to \(Page.report()?.int("sy") ?? -1))")
    let notes1 = Popup.notes()
    XCTAssertEqual(notes0, notes1, "Two fingers changed the notes: \(notes0) then \(notes1)")
    note("twofinger", "scrollY \(before) to \(after?.int("sy") ?? -1), notes stay \(notes1)")
  }

  func test06_DrawOffFingerScrollsAndLinksWork() throws {
    let r = open("off.html")
    XCTAssertTrue(Popup.setDraw(false))
    let before = r.int("sy")
    Touch.drag(CGPoint(x: 400, y: 900), CGPoint(x: 400, y: 500), velocity: .default)
    let after = Page.report(within: 5) { $0.int("sy") > before + 100 }
    XCTAssertNotNil(after, "One finger did not scroll with draw mode off")
    XCTAssertEqual(Popup.notes(), "No notes on this page", "A finger made ink with draw mode off")
    let fresh = open("off.html")
    _ = fresh
    let link = Sim.safari.webViews.links["Jump to the notes"].firstMatch
    if link.exists && !link.isHittable { Sim.safari.webViews.firstMatch.swipeDown() }
    XCTAssertTrue(link.waitForExistence(timeout: 5))
    link.tap()
    let jumped = Page.report(within: 5) { $0.values["hash"] == "#jump" && $0.int("link") >= 1 }
    XCTAssertNotNil(jumped, "The link did not work with draw mode off")
    note("drawoff", "finger scrolled \(before) to \(after?.int("sy") ?? -1); link followed to #jump")
  }

  func test07_ReloadBringsInkBackOnTheWords() throws {
    _ = open("sim.html")
    Page.reload()
    _ = Page.report(within: 10) { $0.int("layer") == 1 }
    let (hits, w) = Marks.onWord(10)
    XCTAssertGreaterThanOrEqual(hits, 3, "After reload the ink is not on the words (\(hits)/5)")
    note("reload", "ink back on the words, \(hits)/5 points, words at \(w?.integral ?? .zero); \(Viewer.how())")
  }

  func test08_RotationKeepsInkOnTheWords() throws {
    let w0 = Page.report(within: 5) { $0.word != nil }?.word
    XCUIDevice.shared.orientation = .landscapeLeft
    let r = Page.report(within: 10) { $0.int("iw") > 1000 }
    XCTAssertNotNil(r, "The page did not get wider in landscape")
    let (hits, w1) = Marks.onWord(10)
    if let a = w0, let b = w1 {
      XCTAssertGreaterThan(abs(a.minX - b.minX) + abs(a.minY - b.minY), 20, "The words did not move in landscape, so this proves nothing")
    }
    XCTAssertGreaterThanOrEqual(hits, 3, "In landscape the ink is not on the words (\(hits)/5)")
    XCUIDevice.shared.orientation = .portrait
    _ = Page.report(within: 10) { $0.int("iw") < 900 }
    let (back, _) = Marks.onWord(10)
    XCTAssertGreaterThanOrEqual(back, 3, "Back in portrait the ink is not on the words (\(back)/5)")
    note("rotate", "words moved \(w0?.integral ?? .zero) to \(w1?.integral ?? .zero) in landscape; ink followed (\(hits)/5, back \(back)/5)")
  }

  func test09_InkSurvivesSafariRelaunch() throws {
    // Settings hands the request to Safari, which may carry it out as it starts. Give it
    // that start before the page loads.
    Sim.safari.terminate()
    Sim.safari.launch()
    Thread.sleep(forTimeInterval: 5)
    Sim.safari.terminate()
    Sim.safari.launch()
    _ = open("sim.html")
    let (hits, _) = Marks.onWord(15)
    XCTAssertGreaterThanOrEqual(hits, 3, "After Safari was quit and opened again the ink is gone (\(hits)/5)")
    note("relaunch", "ink on the words after quitting Safari, \(hits)/5; \(Viewer.how())")
  }

  func test10_AccordionSection() throws {
    let r = open("accordion.html")
    XCTAssertTrue(Popup.setDraw(true))
    Marks.strokeWord(r)
    let (hits, w) = Marks.onWord()
    XCTAssertGreaterThanOrEqual(hits, 3, "No ink on the words in the open section")
    guard let word = w else { return }
    let summary = Sim.safari.webViews.descendants(matching: .any).matching(
      NSPredicate(format: "label CONTAINS 'Second section'")).firstMatch
    XCTAssertTrue(summary.exists, "No summary for the second section")
    summary.tap()
    let closed = Page.report(within: 5) { $0.values["open"] == "0" }
    let left = Shot().inkCount(in: word.insetBy(dx: -12, dy: -6))
    summary.tap()
    let reopened = Page.report(within: 5) { $0.values["open"] == "1" }
    let (back, _) = Marks.onWord(8)
    XCTAssertNotNil(reopened, "The section did not open again")
    note("accordion", "drawn on words in the open section (\(hits)/5). Tap closed it: \(closed != nil ? "closed" : "did not close"); " +
      "ink pixels left where the words were: \(left). Reopened: ink on the words \(back)/5")
  }

  func test11_InnerScroller() throws {
    let r = open("scroller.html")
    XCTAssertTrue(Popup.setDraw(true))
    Marks.strokeWord(r)
    let (hits, w) = Marks.onWord()
    XCTAssertGreaterThanOrEqual(hits, 3, "No ink on the words in the inner box")
    guard let word = w else { return }
    try Touch.twoFingers(at: CGPoint(x: word.midX, y: word.maxY + 120), dy: -120)
    let moved = Page.report(within: 5) { $0.int("ins") > 0 }
    let ins = moved?.int("ins") ?? 0
    var where_ = "the box did not scroll"
    if moved != nil {
      let (h, nw) = Marks.onWord(5)
      let stale = Shot().inkCount(in: word.insetBy(dx: -4, dy: -4))
      where_ = "box scrolled \(ins) px; ink on the words at their new place \(h)/5 (words now \(nw?.integral ?? .zero)); ink pixels left at the old place \(stale)"
    }
    note("scroller", "drawn on words in the box (\(hits)/5). Two fingers in the box: \(where_)")
  }

  func test12_PdfViewerOpensServedPdf() throws {
    // A PDF address hands the file to the extension's own viewer. That page does not load
    // Safari's accessibility in the simulator, so the check is on the screenshot: the page
    // shows dark text where Safari's own viewer would show its grey page.
    Sim.safari.open(Sim.url("paper.pdf"))
    var dark = 0
    _ = waitFor(25, poll: 1) {
      dark = Shot().textCount(in: CGRect(x: 100, y: 250, width: 520, height: 260))
      return dark > 150
    }
    note("pdf", "a served PDF opens in the viewer; \(dark) dark text samples in its first page")
    XCTAssertGreaterThan(dark, 150, "The PDF's text did not show")
  }

  func test13_ClearingWebsiteDataKeepsInk() throws {
    let s = Sim.settings
    XCTAssertTrue(openSafariSettings(s), "Safari is not in Settings > Apps")
    // Website Data under Advanced lists no 127.0.0.1 entry in the simulator, so this clears
    // the data of every site. The page's own localStorage mark shows that it happened.
    let clear = s.buttons["CLEAR_HISTORY_AND_DATA"].reveal(in: s, tries: 14)
    XCTAssertTrue(clear.isHittable, "No Clear History and Website Data in Settings > Apps > Safari")
    clear.tap()
    // The sheet: timeframe All history, Close All Tabs on, then Clear History. Closing the
    // tabs ends their web content, so no page keeps the old storage in memory.
    let all = s.staticTexts["All history"].firstMatch
    XCTAssertTrue(all.waitForExistence(timeout: 5), "No timeframe choice after Clear History and Website Data")
    all.tap()
    let tabs = s.switches["CloseAllTabsSwitch"].firstMatch
    if tabs.exists, (tabs.value as? String) != "1" { tabs.tap() }
    let confirm = s.buttons["ClearHistoryButton"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "No Clear History button in the sheet")
    confirm.tap()
    XCTAssertTrue(waitFor(10) { !confirm.exists }, "The Clear History sheet did not close")
    s.terminate()

    // Settings hands the request to Safari, which may carry it out as it starts. Give it
    // that start before the page loads.
    Sim.safari.terminate()
    Sim.safari.launch()
    Thread.sleep(forTimeInterval: 5)
    Sim.safari.terminate()
    Sim.safari.launch()
    // The first load after clearing tells: the page sets its marks again as it loads.
    let fresh = open("sim.html")
    note("sitedata_page", "after clearing, the page's localStorage is \(fresh.values["ls"] ?? "?") and its cookie is \(fresh.values["ck"] ?? "?")")
    // In the simulator the cookie goes and localStorage for 127.0.0.1 stays. Either one
    // gone shows that the site's data was cleared.
    XCTAssertTrue(fresh.values["ls"] == "new" || fresh.values["ck"] == "new", "The site's own data was not cleared")
    let (hits, _) = Marks.onWord(15)
    XCTAssertGreaterThanOrEqual(hits, 3, "The ink went away with the site's data (\(hits)/5)")
    note("sitedata", "Clear History and Website Data (all history) in Settings; ink still on the words \(hits)/5")
  }

  func test14_AppLibraryListsThePageAndExports() throws {
    let app = Sim.app
    app.launch()
    let notesTab = app.buttons["Notes"].firstMatch
    if notesTab.waitForExistence(timeout: 10) { notesTab.tap() }
    let unavailable = app.staticTexts["Storage is not available"].firstMatch
    XCTAssertFalse(unavailable.waitForExistence(timeout: 3), "The app has no App Group storage. The simulator build must be signed to run locally.")
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Simulator page'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20), "The page written in Safari is not in the app's Notes")
    let export = app.buttons["Export and Import"].firstMatch
    XCTAssertTrue(export.waitForExistence(timeout: 5))
    export.tap()
    let share = app.buttons["Share Archive"].firstMatch
    XCTAssertTrue(share.waitForExistence(timeout: 5))
    share.tap()
    let sheet = app.otherElements["ActivityListView"].firstMatch
    let shown = sheet.waitForExistence(timeout: 10) || app.navigationBars["UIActivityContentView"].waitForExistence(timeout: 2)
    XCTAssertTrue(shown, "The share sheet with the archive did not open")
    note("app", "the app lists Simulator page; Share Archive opens the share sheet")
    app.terminate()
  }

  func test15_StylusInputInXCTest() throws {
    let selectors = SynthSelectors()
    let hits = selectors.split(separator: "\n").filter {
      let s = $0.lowercased()
      return s.contains("stylus") || s.contains("pencil") || s.contains("azimuth") || s.contains("altitude")
    }
    note("stylus", hits.isEmpty
      ? "XCTest event synthesis here has touch, mouse, pressure, key and text paths only. No stylus input."
      : "stylus related selectors: \(hits.joined(separator: ", "))")
  }
}
