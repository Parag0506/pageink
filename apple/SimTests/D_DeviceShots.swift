import XCTest

/// Screenshots for the device check on a real iPad (apple/device). It opens the check page in
/// Safari and then only watches: it never taps, types or changes a setting. Each step of the check page names itself in the label of
/// its main region ("check hello write"). Whenever that label changes, this takes a screenshot
/// and keeps it in the result bundle, named by the label. It stops when the page says done.
///
/// It runs only when the device check passes TEST_RUNNER_INK_CHECK_URL, so the simulator
/// suite skips it.
final class D_DeviceShots: XCTestCase {
  func test01_ScreenshotEachStep() throws {
    let env = ProcessInfo.processInfo.environment
    guard let address = env["INK_CHECK_URL"], let url = URL(string: address) else {
      throw XCTSkip("Only for the device check")
    }
    let minutes = Double(env["INK_CHECK_MINUTES"] ?? "") ?? 60
    let safari = Sim.safari
    // Safari opened by the test, so its screen can be read. This happens before the person
    // starts, and the check page keeps its place on the Mac, so nothing is lost.
    safari.launch()
    safari.open(url)
    let main = safari.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'check '")).firstMatch
    let end = Date().addingTimeInterval(minutes * 60)
    var last = ""
    var n = 0
    while Date() < end {
      let label = main.exists ? main.label : ""
      if !label.isEmpty && label != last {
        last = label
        // Let the screen settle after the change.
        Thread.sleep(forTimeInterval: 0.8)
        n += 1
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = String(format: "%02d %@", n, label.replacingOccurrences(of: "check ", with: "").replacingOccurrences(of: ", main", with: ""))
        shot.lifetime = .keepAlways
        add(shot)
        if label.contains(" done") { break }
      }
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
