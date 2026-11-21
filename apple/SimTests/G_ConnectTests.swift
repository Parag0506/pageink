import XCTest

/// The app's Sync screen offers the three places, and a cloud without a client id in this
/// build says so instead of opening a sign-in window.
final class G_ConnectTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  func test01_SyncScreenShowsTheThreeChoices() throws {
    let app = Sim.app
    app.launchArguments = ["-InkPane", "sync"]
    app.launch()
    let google = app.descendants(matching: .any)["connect-google"].firstMatch
    XCTAssertTrue(google.waitForExistence(timeout: 15), "No Google Drive choice on the Sync screen")
    let onedrive = app.descendants(matching: .any)["connect-onedrive"].firstMatch
    let folder = app.descendants(matching: .any)["connect"].firstMatch
    XCTAssertTrue(onedrive.exists, "No OneDrive choice")
    XCTAssertTrue(folder.exists, "No folder choice")
    XCTAssertTrue(folder.label.contains("iCloud Drive"), "The folder choice does not name iCloud Drive: \(folder.label)")
    // run.sh says whether this build has client ids (apple/Shared/cloud-ids.local.json).
    let hasIds = ProcessInfo.processInfo.environment["INK_CLOUD_IDS"] == "1"
    for (name, e) in [("Google Drive", google), ("OneDrive", onedrive)] {
      XCTAssertTrue(e.label.contains(name), e.label)
      if hasIds {
        XCTAssertTrue(e.label.contains("Sign in with"), e.label)
      } else {
        XCTAssertTrue(e.label.contains("Not set up in this build."), e.label)
        XCTAssertFalse(e.isEnabled, "\(name) can be tapped without a client id")
      }
    }
    note("connect", "Sync screen: Google Drive, OneDrive and a folder (iCloud Drive named); clouds \(hasIds ? "ready to sign in" : "say Not set up in this build.")")
    app.terminate()
  }
}
