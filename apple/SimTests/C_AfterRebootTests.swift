import XCTest

/// Runs after run.sh has shut the simulator down and booted it again.
final class C_AfterRebootTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    XCUIDevice.shared.orientation = .portrait
  }

  override func tearDown() {
    attach(self, name)
  }

  func test01_InkSurvivesSimulatorReboot() throws {
    Sim.safari.launch()
    Page.open("sim.html")
    XCTAssertNotNil(Page.report(), "sim.html did not load after the reboot")
    let (hits, _) = Marks.onWord(20)
    XCTAssertGreaterThanOrEqual(hits, 3, "After the simulator rebooted the ink is not on the words (\(hits)/5)")
    note("reboot", "ink on the words after the simulator rebooted, \(hits)/5; \(Viewer.how())")
  }
}
