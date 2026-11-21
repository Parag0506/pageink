import Foundation
import SafariServices
#if os(macOS)
import AppKit
#endif

/// Receives `browser.runtime.sendNativeMessage` from the extension and answers with
/// NATIVE_PROTOCOL.md version 1. The work happens in `NativeHandler`, which the tests cover.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]

        let name = Bundle.main.object(forInfoDictionaryKey: "InkStoreName") as? String ?? "Notes"
        let space = SharedSpace.appGroup()
        // A cloud is reached from here when it is the place. The handler has little time, so
        // it waits less on a busy provider than the app does, and leaves the rest in the queue.
        let cloud = space.map { s in
            CloudRoutes(kit: CloudSetup.standard(space: s, retry: .handler), appURL: CloudSetup.appURL(),
                        openApp: Self.openApp)
        }
        let handler = NativeHandler(
            target: { NativeTarget.forExtension(space: SharedSpace.appGroup(), defaultName: name) },
            onAccess: { all in
                guard let space = SharedSpace.appGroup() else { return }
                // Written only when it changes, so the app's check stays steady.
                if space.siteAccess?.all != all { space.siteAccess = SiteAccess(all: all, at: Date()) }
            },
            cloud: cloud,
            forgetFolder: {
                guard let space = SharedSpace.appGroup() else { return }
                space.folderLink = nil
                space.mirrorState = MirrorState()
                space.extensionAccess = nil
            }
        )
        Task {
            let reply = await handler.handleAsync(message)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    /// On the Mac the handler opens the app to finish a sign-in. On iPadOS an extension cannot
    /// open an app, so the extension's page offers the address as a button instead.
    static var openApp: ((URL) -> Void)? {
        #if os(macOS)
        return { url in NSWorkspace.shared.open(url) }
        #else
        return nil
        #endif
    }
}
