import Foundation
import SwiftUI
#if os(macOS)
import AppKit
import SafariServices
#else
import UIKit
#endif

enum AppInfo {
    /// The name from Config/PageInk.xcconfig, through Info.plist. The process name is the last
    /// resort, so no name is written in the code.
    static var name: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? ProcessInfo.processInfo.processName
    }
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
    static var extensionID: String {
        Bundle.main.object(forInfoDictionaryKey: "InkExtensionID") as? String ?? ""
    }
    /// A plain article page to try the pen on.
    static let testPage = URL(string: "https://en.wikipedia.org/wiki/Handwriting")!
}

enum ExtensionState: Equatable {
    case unknown
    case on
    case off
}

enum Platform {
    /// Opens a page in Safari, not just the default browser, where the platform allows it.
    @MainActor static func openInSafari(_ url: URL) {
        #if os(macOS)
        let config = NSWorkspace.OpenConfiguration()
        if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
            NSWorkspace.shared.open([url], withApplicationAt: safari, configuration: config)
        } else {
            NSWorkspace.shared.open(url)
        }
        #else
        // Safari answers the x-safari- prefix. When it does not, the default browser opens the page.
        if let s = URL(string: "x-safari-" + url.absoluteString), url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(s) { ok in
                if !ok { UIApplication.shared.open(url) }
            }
        } else {
            UIApplication.shared.open(url)
        }
        #endif
    }

    /// Whether Safari has the extension turned on. Only macOS can tell.
    static func extensionState() async -> ExtensionState {
        #if os(macOS)
        let id = AppInfo.extensionID
        return await withCheckedContinuation { cont in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: id) { state, error in
                if let state, error == nil {
                    cont.resume(returning: state.isEnabled ? .on : .off)
                } else {
                    cont.resume(returning: .unknown)
                }
            }
        }
        #else
        return .unknown
        #endif
    }

    #if os(macOS)
    static func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: AppInfo.extensionID) { _ in }
    }

    static func showInFinder(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    #else
    static func openSettings() {
        if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
    }

    /// Opens the Files app at a folder.
    static func showInFiles(_ url: URL) {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        c?.scheme = "shareddocuments"
        if let u = c?.url { UIApplication.shared.open(u) }
    }
    #endif
}
