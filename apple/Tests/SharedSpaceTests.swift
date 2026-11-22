import XCTest

/// Where the app and the extension meet (Shared/SharedSpace.swift): the App Group's folder, or
/// the folder of the Mac build signed to run locally (Config/Local-macOS.entitlements).
final class SharedSpaceTests: XCTestCase {
    func dir(_ path: String) -> URL { URL(fileURLWithPath: path, isDirectory: true) }

    /// A Mac build with no team names its group exactly like the app. macOS then gives the app
    /// its own container, and the extension another folder for the same name.
    func testAGroupThatIsTheAppsOwnContainerIsNotShared() {
        let home = dir("/Users/reader/Library/Containers/org.example.app/Data")
        XCTAssertNil(SharedSpace.sharedRoot(group: "org.example.app", home: home) { _ in home })
        // The same folder written another way.
        let again = URL(fileURLWithPath: "/Users/reader/Library/Containers/org.example.app/Data/Library/..")
        XCTAssertNil(SharedSpace.sharedRoot(group: "org.example.app", home: home) { _ in again })
    }

    func testAGroupFolderIsShared() {
        // The sandboxed app and the extension, each with its own home, get the same answer.
        let group = dir("/Users/reader/Library/Group Containers/ABCDE12345.org.example.app")
        for home in ["/Users/reader/Library/Containers/org.example.app/Data",
                     "/Users/reader/Library/Containers/org.example.app.extension/Data",
                     // A build that is not sandboxed has the reader's home.
                     "/Users/reader"] {
            var asked: [String] = []
            let got = SharedSpace.sharedRoot(group: "ABCDE12345.org.example.app", home: dir(home)) {
                asked.append($0)
                return group
            }
            XCTAssertEqual(got, group, home)
            XCTAssertEqual(asked, ["ABCDE12345.org.example.app"])
        }
        // iPadOS keeps groups apart from app data.
        let pad = dir("/private/var/mobile/Containers/Shared/AppGroup/0A1B")
        let padHome = dir("/private/var/mobile/Containers/Data/Application/2C3D")
        XCTAssertEqual(SharedSpace.sharedRoot(group: "group.example", home: padHome) { _ in pad }, pad)
    }

    func testNoGroupMeansNoFolder() {
        let home = dir("/Users/reader")
        var asked = 0
        XCTAssertNil(SharedSpace.sharedRoot(group: "", home: home) { _ in
            asked += 1
            return home.appendingPathComponent("x")
        })
        XCTAssertEqual(asked, 0, "The system was asked about an empty group")
        XCTAssertNil(SharedSpace.sharedRoot(group: "g", home: home) { _ in nil })
    }

    /// The build signed to run locally: the app and the extension have different homes and the
    /// same exception, and must come to the same folder without asking about a group.
    func testTheLocalBuildsFolderIsTheSameForBothSides() throws {
        let exceptions = ["/Library/Application Support/org.example.app.local/"]
        let want = dir("/Users/reader/Library/Application Support/org.example.app.local")
        let local = try XCTUnwrap(SharedSpace.localStore(exceptions: exceptions, userHome: "/Users/reader"))
        XCTAssertEqual(local.path, want.path)
        for home in ["/Users/reader/Library/Containers/org.example.app/Data",
                     "/Users/reader/Library/Containers/org.example.app.extension/Data"] {
            var asked = 0
            let got = SharedSpace.sharedRoot(group: "org.example.app", home: dir(home), local: local) { _ in
                asked += 1
                return self.dir(home)
            }
            XCTAssertEqual(got?.path, want.path, home)
            XCTAssertEqual(asked, 0, "The system was asked about a group although the build has its own folder")
        }
    }

    func testOnlyAPlainLibraryFolderCountsAsTheLocalFolder() {
        let home = "/Users/reader"
        XCTAssertNil(SharedSpace.localStore(exceptions: nil, userHome: home))
        XCTAssertNil(SharedSpace.localStore(exceptions: [], userHome: home))
        XCTAssertNil(SharedSpace.localStore(exceptions: ["/Documents/x/"], userHome: home))
        XCTAssertNil(SharedSpace.localStore(exceptions: ["/Library/x"], userHome: home), "Not a folder")
        XCTAssertNil(SharedSpace.localStore(exceptions: ["/Library/../x/"], userHome: home))
        XCTAssertNil(SharedSpace.localStore(exceptions: ["Library/x/"], userHome: home))
        XCTAssertNil(SharedSpace.localStore(exceptions: ["/Library/x/"], userHome: ""))
        XCTAssertEqual(SharedSpace.localStore(exceptions: ["/Library/x/"], userHome: home)?.path, "/Users/reader/Library/x")
    }

    /// The tests are not signed with the exception, as no build but the local one is.
    func testThisProcessHasNoLocalFolder() {
        XCTAssertNil(SharedSpace.localStore())
    }

    // MARK: The signing files

    func configFile(_ name: String) throws -> String {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Config").appendingPathComponent(name)
        return try String(contentsOf: file, encoding: .utf8)
    }

    func entitlements(_ name: String) throws -> [String: Any] {
        let data = Data(try configFile(name).utf8)
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any], name)
    }

    /// The local build's file gives the app and the extension one folder, the one `localStore`
    /// accepts, and the sandbox they need. It is the only file with the exception.
    func testTheLocalEntitlementsNameOneFolderAndNoOtherFileDoes() throws {
        let local = try entitlements("Local-macOS.entitlements")
        let paths = try XCTUnwrap(local[SharedSpace.localStoreEntitlement] as? [String])
        XCTAssertEqual(paths.count, 1)
        XCTAssertTrue(paths[0].contains("$(INK_BUNDLE_ID_BASE)"), "The folder is not named after the bundle id base")
        XCTAssertNotNil(SharedSpace.localStore(exceptions: paths, userHome: "/Users/reader"))
        XCTAssertEqual(local["com.apple.security.app-sandbox"] as? Bool, true)
        // No group: macOS would not share it, and asking for one stops the app with a question.
        XCTAssertNil(local["com.apple.security.application-groups"])

        for name in ["App-macOS.entitlements", "Extension-macOS.entitlements", "App-iOS.entitlements", "Extension-iOS.entitlements"] {
            let e = try entitlements(name)
            XCTAssertFalse(e.keys.contains { $0.contains("temporary-exception") }, "\(name) carries a sandbox exception")
            XCTAssertEqual(e["com.apple.security.application-groups"] as? [String], ["$(INK_APP_GROUP)"], name)
        }
    }

    /// The App Group ids are what the builds in the App Store were signed with.
    func testTheGroupIdsInTheConfigStay() throws {
        let lines = try configFile("PageInk.xcconfig").split(separator: "\n").map(String.init)
        XCTAssertTrue(lines.contains("INK_APP_GROUP = group.$(INK_BUNDLE_ID_BASE)"))
        XCTAssertTrue(lines.contains("INK_APP_GROUP[sdk=macosx*] = $(TeamIdentifierPrefix)$(INK_BUNDLE_ID_BASE)"))
    }
}
