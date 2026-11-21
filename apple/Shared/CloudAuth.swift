import CryptoKit
import Foundation

public enum ProviderID: String, Codable, CaseIterable, Sendable {
    case google, onedrive

    /// The name the reader sees.
    public var name: String { self == .google ? "Google Drive" : "OneDrive" }
    /// The account kind the reader signs in with.
    public var accountKind: String { self == .google ? "Google" : "Microsoft" }
}

/// The OAuth client ids this build was made with. They are not secrets. The committed
/// `cloud-ids.json` keeps them empty; a git-ignored `cloud-ids.local.json` next to it holds the
/// real ones (docs/CLOUD_SETUP.md, "The Apple app"). With an empty id that choice shows
/// "Not set up in this build."
public struct ClientIds: Codable, Equatable, Sendable {
    /// The "iOS" client from the same Google Cloud project as the extension's web client.
    public var google: String
    /// The Microsoft app registration's Application (client) id.
    public var microsoft: String

    public init(google: String = "", microsoft: String = "") {
        self.google = google
        self.microsoft = microsoft
    }

    public static let none = ClientIds()

    public func id(_ p: ProviderID) -> String {
        (p == .google ? google : microsoft).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func isSetUp(_ p: ProviderID) -> Bool { !id(p).isEmpty }

    /// `cloud-ids.json` from the bundle, with `cloud-ids.local.json` over it when present.
    public static func load(bundle: Bundle = .main) -> ClientIds {
        var out = ClientIds()
        for name in ["cloud-ids", "cloud-ids.local"] {
            guard let u = bundle.url(forResource: name, withExtension: "json"),
                  let d = try? Data(contentsOf: u),
                  let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            if let g = o["google"] as? String, !g.isEmpty { out.google = g }
            if let m = o["microsoft"] as? String, !m.isEmpty { out.microsoft = m }
        }
        return out
    }
}

/// Where the sign-in page sends the reader back to, and the scheme the system sign-in window
/// waits for.
public struct Redirect: Equatable, Sendable {
    public var uri: String
    public var scheme: String
}

public enum Redirects {
    /// The return address for each provider. CHECK with real client ids, on a Mac and an iPad:
    ///
    /// - Google: the client must be of type "iOS", for the iPad and the Mac alike ("For iOS and
    ///   macOS apps the OAuth client ID application type must be configured as iOS", Google
    ///   Sign-In for iOS and macOS, "Get started"). Its return address uses the reversed client
    ///   id as the scheme. Check that `:/oauthredirect` is accepted as the path, that the token
    ///   address answers without a client secret, and that a refresh token comes back without
    ///   `access_type=offline`.
    /// - Microsoft: "iOS apps implementing our OAuth protocols directly" register the address
    ///   under "Mobile and desktop applications" (Microsoft identity platform, "Redirect URI
    ///   best practices"). `msauth.<bundle id>://auth` is the form the "iOS / macOS" platform
    ///   makes, so either entry works. Check that a personal and a work account both come back.
    ///
    /// The system sign-in window catches the return address itself, so the scheme does not
    /// need to be listed in Info.plist.
    public static func of(_ p: ProviderID, ids: ClientIds, bundleId: String) -> Redirect? {
        guard ids.isSetUp(p) else { return nil }
        switch p {
        case .google:
            // 1234-abc.apps.googleusercontent.com becomes com.googleusercontent.apps.1234-abc
            let scheme = ids.id(.google).split(separator: ".").reversed().joined(separator: ".")
            return Redirect(uri: "\(scheme):/oauthredirect", scheme: scheme)
        case .onedrive:
            guard !bundleId.isEmpty else { return nil }
            let scheme = "msauth.\(bundleId)"
            return Redirect(uri: "\(scheme)://auth", scheme: scheme)
        }
    }
}

/// The tokens for one cloud. Kept in the keychain only (SecretStore), as JSON.
public struct Tokens: Codable, Equatable, Sendable {
    public var access: String
    /// Epoch ms when the access token stops working.
    public var exp: Int64
    public var refresh: String?
    /// The account shown to the reader.
    public var account: String?

    public init(access: String, exp: Int64, refresh: String? = nil, account: String? = nil) {
        self.access = access
        self.exp = exp
        self.refresh = refresh
        self.account = account
    }

    public static func key(_ p: ProviderID) -> String { "tokens.\(p.rawValue)" }
}

public func nowMillis() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

/// PKCE (RFC 7636) and the random state.
public enum PKCE {
    public static func randomText(_ bytes: Int = 32) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        if SecRandomCopyBytes(kSecRandomDefault, bytes, &b) != errSecSuccess {
            for i in b.indices { b[i] = UInt8.random(in: 0...255) }
        }
        return b64url(Data(b))
    }

    public static func challenge(_ verifier: String) -> String {
        b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// The addresses each provider's sign-in uses. Tests point them at nothing: stubs answer.
public enum AuthHosts {
    public static let googleAuth = "https://accounts.google.com/o/oauth2/v2/auth"
    public static let googleToken = "https://oauth2.googleapis.com/token"
    public static let googleRevoke = "https://oauth2.googleapis.com/revoke"
    public static let msAuth = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    public static let msToken = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
}

/// The scopes asked for, and no others: the same as the extension's. Google: drive.file, the
/// files the app made. Microsoft: the app folder only and a refresh token. No openid, profile
/// or email, so no account name comes with the tokens. Google's name comes from Drive itself;
/// OneDrive shows "Connected to OneDrive" alone, as the extension does.
public enum Scopes {
    public static let google = "https://www.googleapis.com/auth/drive.file"
    public static let microsoft = "Files.ReadWrite.AppFolder offline_access"
}

/// A sign-in started: what the return must match and what the token request needs.
public struct PendingSignIn: Sendable {
    public var provider: ProviderID
    public var url: URL
    public var redirect: Redirect
    public var state: String
    public var verifier: String
}

/// Sign-in with the authorization code and PKCE, for a public client: no client secret.
public struct OAuth: Sendable {
    public let ids: ClientIds
    public let bundleId: String
    public let http: CloudHTTP

    public init(ids: ClientIds, bundleId: String, net: PinnedNet, retry: Retry) {
        self.ids = ids
        self.bundleId = bundleId
        http = CloudHTTP(net: net, allow: [AuthHosts.googleToken, AuthHosts.googleRevoke, AuthHosts.msToken], retry: retry)
    }

    /// The address to open in the system sign-in window.
    public func start(_ p: ProviderID) throws -> PendingSignIn {
        guard let r = Redirects.of(p, ids: ids, bundleId: bundleId) else { throw CloudError(.notSetUp) }
        let verifier = PKCE.randomText(48)
        let state = PKCE.randomText(16)
        var c = URLComponents(string: p == .google ? AuthHosts.googleAuth : AuthHosts.msAuth)!
        var q: [URLQueryItem] = [
            URLQueryItem(name: "client_id", value: ids.id(p)),
            URLQueryItem(name: "redirect_uri", value: r.uri),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: p == .google ? Scopes.google : Scopes.microsoft),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        if p == .onedrive { q.append(URLQueryItem(name: "response_mode", value: "query")) }
        c.queryItems = q
        guard let url = c.url, PinnedHosts.allows(url) else { throw CloudError(.denied, "address not allowed") }
        return PendingSignIn(provider: p, url: url, redirect: r, state: state, verifier: verifier)
    }

    /// Checks the address the window came back with and trades the code for tokens.
    public func finish(_ s: PendingSignIn, returned: URL) async throws -> Tokens {
        let p = Self.params(returned)
        if let e = p["error"] {
            throw CloudError(.denied, e)
        }
        guard p["state"] == s.state else { throw CloudError(.denied, "state mismatch") }
        guard let code = p["code"], !code.isEmpty else { throw CloudError(.denied, "no code") }
        var form = [("client_id", ids.id(s.provider)), ("grant_type", "authorization_code"), ("code", code),
                    ("redirect_uri", s.redirect.uri), ("code_verifier", s.verifier)]
        if s.provider == .onedrive { form.append(("scope", Scopes.microsoft)) }
        return try await tokenRequest(s.provider, form, interactive: true)
    }

    /// A new access token from the refresh token, without a window. Expired when it is refused.
    public func refresh(_ p: ProviderID, _ old: Tokens) async throws -> Tokens {
        guard let r = old.refresh, !r.isEmpty else { throw CloudError(.expired, "no refresh token") }
        var form = [("client_id", ids.id(p)), ("grant_type", "refresh_token"), ("refresh_token", r)]
        if p == .onedrive { form.append(("scope", Scopes.microsoft)) }
        var t = try await tokenRequest(p, form, interactive: false)
        // Google keeps the refresh token; Microsoft may send a new one.
        if t.refresh == nil { t.refresh = r }
        if t.account == nil { t.account = old.account }
        return t
    }

    /// Gives a Google token back. Microsoft has no address for a public client to do this.
    public func revoke(_ p: ProviderID, _ t: Tokens) async {
        guard p == .google, let u = URL(string: AuthHosts.googleRevoke) else { return }
        _ = try? await http.send(u, method: "POST", headers: ["Content-Type": "application/x-www-form-urlencoded"],
                                 body: JSONBody.form([("token", t.refresh ?? t.access)]))
    }

    private func tokenRequest(_ p: ProviderID, _ form: [(String, String)], interactive: Bool) async throws -> Tokens {
        let u = URL(string: p == .google ? AuthHosts.googleToken : AuthHosts.msToken)!
        let r = try await http.send(u, method: "POST", headers: ["Content-Type": "application/x-www-form-urlencoded"],
                                    body: JSONBody.form(form))
        let o = (try? JSONBody.object(r.body)) ?? [:]
        guard r.status == 200, let access = o["access_token"] as? String else {
            let e = o["error"] as? String ?? String(r.status)
            if r.status >= 500 { throw CloudError(.server, status: r.status) }
            throw CloudError(e == "invalid_grant" || e == "interaction_required" || !interactive ? .expired : .denied, e)
        }
        let expires = (o["expires_in"] as? NSNumber)?.doubleValue ?? Double(o["expires_in"] as? String ?? "") ?? 3600
        var t = Tokens(access: access, exp: nowMillis() + Int64(expires * 1000))
        t.refresh = o["refresh_token"] as? String
        if let scope = o["scope"] as? String, p == .google,
           !scope.split(separator: " ").contains(where: { $0 == Scopes.google }) {
            // The reader unticked Drive access on the consent page.
            throw CloudError(.denied, "scope")
        }
        return t
    }

    /// The parameters in the query and the fragment of a returned address.
    static func params(_ url: URL) -> [String: String] {
        var out: [String: String] = [:]
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        for i in c?.queryItems ?? [] { out[i.name] = i.value ?? "" }
        if let f = c?.fragment, var fc = URLComponents(string: "x:/") {
            fc.query = f
            for i in fc.queryItems ?? [] { out[i.name] = i.value ?? "" }
        }
        return out
    }
}

/// The access token for requests, renewed in one place. Two requests that both find the token
/// old share one renewal. The tokens live in the keychain, so the app and the extension see
/// the same ones.
public final class TokenSession: @unchecked Sendable {
    let provider: ProviderID
    let secrets: SecretStore
    let renewFn: @Sendable (Tokens) async throws -> Tokens
    let now: @Sendable () -> Int64
    private let lock = NSLock()
    private var renewing: Task<String, Error>?

    public init(provider: ProviderID, secrets: SecretStore, now: @escaping @Sendable () -> Int64 = nowMillis,
                renew: @escaping @Sendable (Tokens) async throws -> Tokens) {
        self.provider = provider
        self.secrets = secrets
        self.now = now
        renewFn = renew
    }

    public var tokens: Tokens? { secrets.getJSON(Tokens.key(provider)) }

    public func get() async throws -> String {
        // A minute early, so a token never runs out in the middle of a request.
        if let t = tokens, t.exp - 60_000 > now() { return t.access }
        return try await renew()
    }

    public func renew() async throws -> String {
        let (task, mine) = claim()
        defer { if mine { release() } }
        return try await task.value
    }

    /// The renewal under way, or a new one. `mine` is true for the caller that started it.
    private func claim() -> (Task<String, Error>, Bool) {
        lock.lock()
        defer { lock.unlock() }
        if let r = renewing { return (r, false) }
        let task = Task<String, Error> { [self] in
            guard let old = tokens else { throw CloudError(.expired, "not signed in") }
            let t = try await renewFn(old)
            try secrets.setJSON(Tokens.key(provider), t)
            return t.access
        }
        renewing = task
        return (task, true)
    }

    private func release() {
        lock.lock()
        renewing = nil
        lock.unlock()
    }

    public var source: TokenSource {
        TokenSource(get: { [self] in try await get() }, renew: { [self] in try await renew() })
    }
}
