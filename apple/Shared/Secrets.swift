import Foundation
import Security

/// Where sign-in tokens and the lock's key are kept. Never in a file, never in the notes.
public protocol SecretStore: AnyObject, Sendable {
    func get(_ key: String) -> Data?
    func set(_ key: String, _ value: Data) throws
    func remove(_ key: String)
}

extension SecretStore {
    public func getJSON<T: Decodable>(_ key: String, _ type: T.Type = T.self) -> T? {
        get(key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    public func setJSON<T: Encodable>(_ key: String, _ value: T) throws {
        try set(key, JSONEncoder().encode(value))
    }
}

/// The keychain, in the App Group's access group, so the app and its Safari extension read the
/// same items. Items stay on this device: they are not synced to other devices or restored
/// from a backup to another one. They can be read after the first unlock, so the extension can
/// sync while the screen is locked.
public final class KeychainStore: SecretStore, @unchecked Sendable {
    let service: String
    let group: String?

    public init(service: String, group: String?) {
        self.service = service
        self.group = group
    }

    /// The store the app and the extension share, named after the App Group in Info.plist.
    public static func shared(bundle: Bundle = .main) -> KeychainStore {
        let group = bundle.object(forInfoDictionaryKey: "InkAppGroup") as? String
        let usable = (group?.isEmpty == false) ? group : nil
        return KeychainStore(service: (usable ?? bundle.bundleIdentifier ?? "app") + ".cloud", group: usable)
    }

    /// The query for one item: this service, this App Group's access group, the data protection
    /// keychain. Internal so a test can check the scope.
    func base(_ key: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    public func get(_ key: String) -> Data? {
        var q = base(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    /// Readable after the first unlock, on this device only: never synced, never restored to another one.
    static let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    public func set(_ key: String, _ value: Data) throws {
        let attrs: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: Self.accessible,
        ]
        var status = SecItemUpdate(base(key) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var q = base(key)
            q.merge(attrs) { _, b in b }
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CloudError(.denied, "keychain \(status)") }
    }

    public func remove(_ key: String) {
        SecItemDelete(base(key) as CFDictionary)
    }
}

/// Secrets in memory, for tests.
public final class MemorySecrets: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    public init() {}
    public func get(_ key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return items[key]
    }
    public func set(_ key: String, _ value: Data) throws {
        lock.lock()
        items[key] = value
        lock.unlock()
    }
    public func remove(_ key: String) {
        lock.lock()
        items[key] = nil
        lock.unlock()
    }
    public var keys: [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(items.keys)
    }
}
