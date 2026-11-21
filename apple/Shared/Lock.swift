import CommonCrypto
import CryptoKit
import Foundation

/// The password lock, as docs/FORMAT.md "Password lock" and src/lock in the extension:
/// PBKDF2-HMAC-SHA-256 (CommonCrypto) for the key, HMAC-SHA-256 for the key check, HKDF for
/// three keys made from it, AES-256-GCM (CryptoKit) for each file with its name bound in,
/// an HMAC over the lock file, and keyed file names. Checked against docs/lock-vectors.json.
public enum LockCrypto {
    public static let iterations = 600_000
    public static let saltBytes = 16
    public static let nonceBytes = 12
    /// Extra data of a version 1 file. Version 1 is read only to move a place to version 2.
    public static let aadV1 = Data("lock-v1".utf8)
    public static let checkText = Data("lock-check-v1".utf8)
    /// Start of the extra data of a version 2 file. The file's name follows it.
    public static let aadV2 = "pageink-lock-v2\n"
    public static let macLabel = "pageink-lock-file-v2"

    /// The three keys made from the lock key, each with one job.
    public enum Use: String {
        case seal = "pageink lock v2 seal"
        case file = "pageink lock v2 lock file"
        case names = "pageink lock v2 names"
    }

    /// The 32 key bytes for a password, taken as Unicode NFC, then UTF-8.
    public static func deriveKey(_ password: String, salt: Data, iterations: Int = iterations) -> Data {
        let utf8 = Array(password.precomposedStringWithCanonicalMapping.utf8)
        // CommonCrypto takes the password as C chars. A trailing 0 keeps the pointer valid when it is empty.
        let pw = utf8.map { Int8(bitPattern: $0) } + [0]
        var out = [UInt8](repeating: 0, count: 32)
        let saltBytes = [UInt8](salt)
        let status = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw, utf8.count, saltBytes, saltBytes.count,
                                          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, 32)
        precondition(status == kCCSuccess, "PBKDF2 failed")
        return Data(out)
    }

    static func hmac(_ key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// HMAC-SHA-256 of "lock-check-v1" under the key. It tells a right password from a wrong one.
    public static func keyCheck(_ key: Data) -> Data { hmac(key, checkText) }

    /// HKDF-SHA-256 with no salt and the label as info: 32 bytes.
    public static func subKey(_ key: Data, _ use: Use) -> Data {
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: key), salt: Data(),
                                       info: Data(use.rawValue.utf8), outputByteCount: 32)
        return k.withUnsafeBytes { Data($0) }
    }

    static let b32Lower = Array("abcdefghijklmnopqrstuvwxyz234567")

    /// The name hash of a page while the lock is on: the first 10 bytes of HMAC-SHA-256 of the
    /// page key under the names key, in lower case base32. 16 letters and digits.
    public static func lockedName(_ key: Data, _ pageKey: String) -> String {
        let mac = hmac(subKey(key, .names), Data(pageKey.utf8)).prefix(10)
        var out = ""
        var bits = 0
        var value = 0
        for b in mac {
            value = ((value << 8) | Int(b)) & 0xffff
            bits += 8
            while bits >= 5 {
                out.append(b32Lower[(value >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        return out
    }

    /// The text the lock file's MAC covers: every field but the MAC, one per line.
    public static func macText(iterations: Int, salt: String, check: String, state: String) -> String {
        "\(macLabel)\nkdf=PBKDF2,SHA-256,\(iterations),\(salt)\ncheck=\(check)\nstate=\(state)\n"
    }

    /// Compare without stopping at the first difference.
    static func same(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var d: UInt8 = 0
        for (x, y) in zip(a, b) { d |= x ^ y }
        return d == 0
    }

    /// Seal the text of a file for the name it is written under: one line of JSON and a newline.
    /// A fresh nonce every time; `nonce` is for the test vectors only.
    public static func seal(_ key: Data, name: String, _ plain: Data, nonce: Data? = nil) throws -> Data {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: subKey(key, .seal)), nonce: n,
                                   authenticating: Data((aadV2 + name).utf8))
        let c = box.ciphertext + box.tag
        let line = "{\"lock\":2,\"alg\":\"A256GCM\",\"f\":\"\(name)\",\"n\":\"\(Data(n).base64EncodedString())\",\"c\":\"\(c.base64EncodedString())\"}\n"
        return Data(line.utf8)
    }

    /// A version 1 file, as older versions wrote them. Only the tests make these now.
    public static func sealV1(_ key: Data, _ plain: Data, nonce: Data? = nil) throws -> Data {
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), nonce: n, authenticating: aadV1)
        let c = box.ciphertext + box.tag
        let line = "{\"lock\":1,\"alg\":\"A256GCM\",\"n\":\"\(Data(n).base64EncodedString())\",\"c\":\"\(c.base64EncodedString())\"}\n"
        return Data(line.utf8)
    }

    public struct Envelope: Equatable {
        public var version: Int
        /// Version 2: the name the file was sealed for.
        public var f: String?
        public var n: Data
        public var c: Data
    }

    /// The envelope inside a file's text, or nil when the file is not sealed.
    public static func envelope(_ d: Data) -> Envelope? {
        // A record starts with {"v" or a newline and spaces. Checking the start first keeps this cheap.
        let head = String(decoding: d.prefix(32), as: UTF8.self).drop { $0.isWhitespace }
        guard head.hasPrefix("{"), head.dropFirst().drop(while: { $0.isWhitespace }).hasPrefix("\"lock\""),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let v = (o["lock"] as? NSNumber)?.intValue, o["alg"] as? String == "A256GCM",
              let n = (o["n"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let c = (o["c"] as? String).flatMap({ Data(base64Encoded: $0) })
        else { return nil }
        if v == 1 { return Envelope(version: 1, f: nil, n: n, c: c) }
        if v == 2, let f = o["f"] as? String { return Envelope(version: 2, f: f, n: n, c: c) }
        return nil
    }

    public struct WrongKey: Error {}

    /// Open a sealed file. Version 2 is opened for the name in the envelope; the caller checks
    /// that name against where the file was found. Throws WrongKey when the key does not fit or
    /// the file was changed.
    public static func unseal(_ key: Data, _ env: Envelope) throws -> Data {
        guard env.c.count >= 16, env.n.count == nonceBytes, let nonce = try? AES.GCM.Nonce(data: env.n) else { throw WrongKey() }
        do {
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: env.c.dropLast(16), tag: env.c.suffix(16))
            if env.version == 2, let f = env.f {
                return try AES.GCM.open(box, using: SymmetricKey(data: subKey(key, .seal)), authenticating: Data((aadV2 + f).utf8))
            }
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aadV1)
        } catch {
            throw WrongKey()
        }
    }

    static let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// The key in base32 (RFC 4648, no padding), in groups of four with dashes.
    public static func recoveryCode(_ key: Data) -> String {
        var bits = 0
        var value = 0
        var out = ""
        for b in key {
            value = ((value << 8) | Int(b)) & 0xffff
            bits += 8
            while bits >= 5 {
                out.append(b32[(value >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 { out.append(b32[(value << (5 - bits)) & 31]) }
        var groups: [String] = []
        var i = out.startIndex
        while i < out.endIndex {
            let j = out.index(i, offsetBy: 4, limitedBy: out.endIndex) ?? out.endIndex
            groups.append(String(out[i..<j]))
            i = j
        }
        return groups.joined(separator: "-")
    }

    /// The key bytes in a recovery code, or nil. Case, spaces and dashes do not matter.
    public static func fromRecoveryCode(_ code: String) -> Data? {
        let s = code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard s.count == 52 else { return nil }
        var out: [UInt8] = []
        var bits = 0
        var value = 0
        for ch in s {
            guard let i = b32.firstIndex(of: ch) else { return nil }
            value = ((value << 5) | i) & 0xffff
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 255))
                bits -= 8
            }
        }
        return out.count >= 32 ? Data(out.prefix(32)) : nil
    }

    public static func random(_ n: Int) -> Data {
        var b = [UInt8](repeating: 0, count: n)
        if SecRandomCopyBytes(kSecRandomDefault, n, &b) != errSecSuccess {
            for i in b.indices { b[i] = UInt8.random(in: 0...255) }
        }
        return Data(b)
    }
}

/// The plain name hash of a page, used while the lock is off: cyrb53 over UTF-16 code units,
/// in base 36. The same as `hashKey` in pageink-core's hash.ts.
public enum PlainName {
    public static func hash(_ s: String) -> String {
        var h1: UInt32 = 0xdeadbeef
        var h2: UInt32 = 0x41c6ce57
        for c in s.utf16 {
            h1 = (h1 ^ UInt32(c)) &* 2654435761
            h2 = (h2 ^ UInt32(c)) &* 1597334677
        }
        h1 = ((h1 ^ (h1 >> 16)) &* 2246822507) ^ ((h2 ^ (h2 >> 13)) &* 3266489909)
        h2 = ((h2 ^ (h2 >> 16)) &* 2246822507) ^ ((h1 ^ (h1 >> 13)) &* 3266489909)
        let v = UInt64(2097151 & h2) * 4294967296 + UInt64(h1)
        return String(v, radix: 36)
    }
}

/// `pageink.lock.json` at the top of the place. It never holds the key.
public struct LockFile: Codable, Equatable {
    public struct KDF: Codable, Equatable {
        public var name = "PBKDF2"
        public var hash = "SHA-256"
        public var iterations: Int
        public var salt: String
    }

    /// 2 for every lock file written now. 1 is read only to move a place to version 2.
    public var v = 2
    public var kdf: KDF
    public var check: String
    public var state: String
    /// Version 2: HMAC-SHA-256 over every other field, under the lock file key.
    public var mac: String?

    public static let name = "pageink.lock.json"

    /// A new lock for a password: fresh salt, the default count, and its key. It starts turning on.
    public static func new(password: String) -> (LockFile, Data) {
        let salt = LockCrypto.random(LockCrypto.saltBytes)
        let key = LockCrypto.deriveKey(password, salt: salt)
        let l = LockFile(kdf: KDF(iterations: LockCrypto.iterations, salt: salt.base64EncodedString()),
                         check: LockCrypto.keyCheck(key).base64EncodedString(), state: "turning-on")
        return (l.signed(key), key)
    }

    var macText: String { LockCrypto.macText(iterations: kdf.iterations, salt: kdf.salt, check: check, state: state) }

    /// This lock as version 2 with its MAC made under the key.
    public func signed(_ key: Data) -> LockFile {
        var l = self
        l.v = 2
        l.mac = LockCrypto.hmac(LockCrypto.subKey(key, .file), Data(macText.utf8)).base64EncodedString()
        return l
    }

    /// True when this is version 2 and its MAC is right for the key.
    public func verify(_ key: Data) -> Bool {
        guard v == 2, let m = mac.flatMap({ Data(base64Encoded: $0) }) else { return false }
        return LockCrypto.same(LockCrypto.hmac(LockCrypto.subKey(key, .file), Data(macText.utf8)), m)
    }

    /// The file's text, as the extension writes it: pretty JSON and a newline.
    public var text: Data {
        var o: [String: Any] = [
            "v": v,
            "kdf": ["name": kdf.name, "hash": kdf.hash, "iterations": kdf.iterations, "salt": kdf.salt],
            "check": check, "state": state,
        ]
        if let mac { o["mac"] = mac }
        var d = (try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        d.append(0x0A)
        return d
    }

    public enum Read: Equatable {
        case none
        case bad
        case lock(LockFile)
    }

    /// A file that cannot be made sense of is "bad". An empty or short salt is refused, since it
    /// would let one table of guesses serve every lock.
    public static func parse(_ d: Data) -> Read {
        guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let v = (o["v"] as? NSNumber)?.intValue, v == 1 || v == 2,
              let k = o["kdf"] as? [String: Any], k["name"] as? String == "PBKDF2", k["hash"] as? String == "SHA-256",
              let it = k["iterations"] as? NSNumber, it.doubleValue == it.doubleValue.rounded(),
              (100_000...10_000_000).contains(it.intValue),
              let salt = k["salt"] as? String, let saltBytes = Data(base64Encoded: salt), saltBytes.count >= LockCrypto.saltBytes,
              let check = o["check"] as? String, Data(base64Encoded: check)?.count == 32,
              let state = o["state"] as? String, ["on", "turning-on", "turning-off"].contains(state)
        else { return .bad }
        let mac = o["mac"] as? String
        if v == 2, mac.flatMap({ Data(base64Encoded: $0) })?.count != 32 { return .bad }
        return .lock(LockFile(v: v, kdf: KDF(iterations: it.intValue, salt: salt), check: check, state: state,
                              mac: v == 2 ? mac : nil))
    }

    public func key(password: String) -> Data {
        LockCrypto.deriveKey(password, salt: Data(base64Encoded: kdf.salt) ?? Data(), iterations: kdf.iterations)
    }

    /// The kept key, when this key opens the lock.
    public func unlock(_ key: Data) -> HeldKey? {
        guard let want = Data(base64Encoded: check), LockCrypto.same(LockCrypto.keyCheck(key), want) else { return nil }
        return HeldKey(key: key.base64EncodedString(), check: check, kdf: kdf)
    }
}

/// The key this device keeps for a lock, in the keychain only. `check` ties it to one lock.
public struct HeldKey: Codable, Equatable {
    public var key: String
    public var check: String
    /// The lock's settings, so this device can put the lock file back if it goes missing.
    public var kdf: LockFile.KDF?
    /// The state this device last wrote or accepted. "turning-off" only when this device started it.
    public var state: String?
    public static let secret = "lockKey"
    public var bytes: Data { Data(base64Encoded: key) ?? Data() }
    public func fits(_ l: LockFile) -> Bool { check == l.check }

    public init(key: String, check: String, kdf: LockFile.KDF? = nil, state: String? = nil) {
        self.key = key
        self.check = check
        self.kdf = kdf
        self.state = state
    }
}

public struct LockProgress: Equatable {
    public var done = 0
    public var left = 0
    /// Files sealed with another key, left as they are.
    public var skipped: [String] = []
    /// Files that are not ours while the lock is on, left as they are.
    public var refused: [String] = []
}

/// What a device should do with the place, given the lock file it found and the key it holds.
public enum LockJudgement: Equatable {
    /// No lock and no key: plain files.
    case plain
    /// A lock and no key that fits.
    case needsPassword
    /// Stop syncing and ask the reader. "missing" or "changed".
    case trouble(String)
    /// The lock is verified. `work`: a turn on or off to finish, or a move from version 1.
    case ready(LockFile, work: Bool)
}

public enum LockSteps {
    static let canonical = try! NSRegularExpression(pattern: "^pages/([0-9a-z]{1,16})(?:\\.[1-9][0-9]?)?\\.ink\\.json$")

    /// The hash part of a name the lock writes or accepts as a page's own, or nil.
    static func canonicalHash(_ name: String) -> String? {
        let r = NSRange(name.startIndex..., in: name)
        guard let m = canonical.firstMatch(in: name, range: r), let h = Range(m.range(at: 1), in: name) else { return nil }
        return String(name[h])
    }

    public static func read(_ io: PlaceIO) async throws -> LockFile.Read {
        do {
            return LockFile.parse(try await io.read(LockFile.name))
        } catch let e as CloudError where e.code == .notFound {
            return .none
        } catch let e as StoreError where e == .notFound {
            return .none
        }
    }

    public static func write(_ io: PlaceIO, _ lock: LockFile, key: Data) async throws -> LockFile {
        let l = lock.signed(key)
        try await io.write(LockFile.name, l.text)
        return l
    }

    /// The one decision, as `judge` in the extension. A held key is only ever given up by the
    /// reader, never here.
    public static func judge(_ read: LockFile.Read, _ held: HeldKey?) -> LockJudgement {
        guard let held else {
            if case .none = read { return .plain }
            return .needsPassword
        }
        guard case .lock(let l) = read else {
            if case .none = read { return .trouble("missing") }
            return .trouble("changed")
        }
        guard held.fits(l) else { return .trouble("changed") }
        if l.v == 1 {
            return l.state == "turning-off" ? .trouble("changed") : .ready(l, work: true)
        }
        guard l.verify(held.bytes) else { return .trouble("changed") }
        if l.state == "turning-off" && held.state != "turning-off" { return .trouble("changed") }
        if l.state == "turning-on" && held.state == "on" { return .trouble("changed") }
        return .ready(l, work: l.state != "on")
    }

    static func recordKey(_ d: Data) -> String? {
        guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let k = o["key"] as? String, !k.isEmpty else { return nil }
        return k
    }

    /// Open a version 2 file found under `name`, and check that it belongs there: sealed for
    /// this very name, or, for a sync copy, for the page whose name the copy starts with. Then
    /// the page key inside must give that name.
    public static func openChecked(_ key: Data, name: String, _ env: LockCrypto.Envelope) throws -> Data {
        guard env.version == 2, let f = env.f, let hash = canonicalHash(f) else { throw LockCrypto.WrongKey() }
        if canonicalHash(name) != nil {
            guard name == f else { throw LockCrypto.WrongKey() }
        } else {
            let base = name.split(separator: "/").last.map(String.init) ?? ""
            guard name.hasPrefix("pages/"), base.hasPrefix(hash) else { throw LockCrypto.WrongKey() }
        }
        let d = try LockCrypto.unseal(key, env)
        guard let k = recordKey(d), LockCrypto.lockedName(key, k) == hash else { throw LockCrypto.WrongKey() }
        return d
    }

    /// Bring every page file to the lock's state, then record it. On and turning on: each file
    /// becomes version 2, sealed under its keyed name. Turning off: each file is opened and
    /// written plain under its plain name, then the lock file goes. A file is written under its
    /// new name before the old one is removed; a name already taken gets a sync copy. Plain
    /// files are taken in only while turning on. A file the key does not open is never touched.
    public static func settle(_ io: PlaceIO, _ lock: LockFile, _ key: Data) async throws -> LockProgress {
        var p = LockProgress()
        let off = lock.state == "turning-off"
        let takePlain = lock.state == "turning-on"
        let files = try await io.list("pages").map { $0.name.contains("/") ? $0.name : "pages/\($0.name)" }
        var taken = Set(files)
        p.left = files.count
        for name in files {
            p.left -= 1
            let d: Data
            do {
                d = try await io.read(name)
            } catch let e as CloudError where e.code == .notFound {
                continue
            } catch let e as StoreError where e == .notFound {
                continue
            }
            let env = LockCrypto.envelope(d)
            var open: Data
            if !off {
                if env?.version == 2 { continue }
                if let env {
                    guard let o = try? LockCrypto.unseal(key, env) else {
                        p.skipped.append(name)
                        continue
                    }
                    open = o
                } else if takePlain {
                    open = d
                } else {
                    p.refused.append(name)
                    continue
                }
            } else {
                guard let env else { continue }
                let o = env.version == 2 ? try? openChecked(key, name: name, env) : try? LockCrypto.unseal(key, env)
                guard let o else {
                    p.skipped.append(name)
                    continue
                }
                open = o
            }
            guard let k = recordKey(open) else {
                if off { p.skipped.append(name) } else { p.refused.append(name) }
                continue
            }
            let hash = off ? PlainName.hash(k) : LockCrypto.lockedName(key, k)
            let canonicalName = "pages/\(hash).ink.json"
            var target = canonicalName
            if target != name && taken.contains(target) {
                let tag = LockCrypto.random(6).base64EncodedString().filter { $0.isLetter || $0.isNumber }.lowercased()
                target = "pages/\(hash) (moved \(tag)).ink.json"
            }
            if !off { open = try LockCrypto.seal(key, name: canonicalName, open) }
            try await io.write(target, open)
            taken.insert(target)
            if target != name { try? await io.remove(name) }
            p.done += 1
        }
        if off {
            if !p.skipped.isEmpty { return p }
            do {
                try await io.remove(LockFile.name)
            } catch let e as CloudError where e.code == .notFound {
            } catch let e as StoreError where e == .notFound {}
        } else if lock.state != "on" || lock.v != 2 {
            var l = lock
            l.state = "on"
            _ = try await write(io, l, key: key)
        }
        return p
    }

    /// Finish what this device may finish (a turn on, a turn off it started, a move from
    /// version 1), and say what it found. Trouble is only reported: the reader chooses.
    @discardableResult
    public static func resume(_ io: PlaceIO, secrets: SecretStore) async throws -> LockJudgement {
        let held = secrets.getJSON(HeldKey.secret, HeldKey.self)
        let j = judge(try await read(io), held)
        guard case .ready(let l, let work) = j, var h = held else { return j }
        if work {
            let p = try await settle(io, l, h.bytes)
            if l.state == "turning-off" {
                if p.skipped.isEmpty { secrets.remove(HeldKey.secret) }
                return p.skipped.isEmpty ? .plain : j
            }
        }
        if h.state != "on" || h.kdf == nil {
            h.state = "on"
            h.kdf = l.kdf
            try? secrets.setJSON(HeldKey.secret, h)
        }
        var on = l
        on.state = "on"
        return .ready(on, work: false)
    }

    /// The text of a file as the library shows it: opened with the key when sealed. Nil when
    /// it is sealed and the key does not open it, or it does not belong under its name.
    public static func open(_ d: Data, key: Data?, name: String) -> Data? {
        guard let env = LockCrypto.envelope(d) else { return d }
        guard let key else { return nil }
        if env.version == 2 { return try? openChecked(key, name: name, env) }
        return try? LockCrypto.unseal(key, env)
    }
}
