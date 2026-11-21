import AuthenticationServices
import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The system sign-in window (ASWebAuthenticationSession). It shows the provider's own page
/// and catches the return address, so the app never sees the password. Cookies are shared
/// with Safari, so a reader already signed in to Google or Microsoft there only confirms.
@MainActor
final class SignInWindow: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Opens `url` and returns the address the provider sent the reader back to.
    func open(_ url: URL, scheme: String) async throws -> URL {
        guard PinnedHosts.allows(url) else { throw CloudError(.denied, "address not allowed") }
        return try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { back, error in
                if let back {
                    cont.resume(returning: back)
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    cont.resume(throwing: CloudError(.cancelled))
                } else {
                    cont.resume(throwing: CloudError(.denied, "sign-in window"))
                }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            session = s
            if !s.start() { cont.resume(throwing: CloudError(.cancelled, "window did not open")) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            #if os(macOS)
            return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
            #else
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? ASPresentationAnchor()
            #endif
        }
    }
}
