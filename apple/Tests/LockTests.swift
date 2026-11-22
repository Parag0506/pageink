import XCTest

/// The password lock against docs/lock-vectors.json, the rules that keep the place from
/// turning it off, and turning it on and off over a folder.
final class LockTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()

    func vectorFile() throws -> [String: Any] {
        let d = try Data(contentsOf: Self.repo.appendingPathComponent("docs/lock-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: d) as? [String: Any])
    }

    func vectors() throws -> [[String: Any]] {
        let v = try XCTUnwrap(try vectorFile()["vectors"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(v.count, 2)
        return v
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

    func testEveryVector() throws {
        for v in try vectors() {
            let password = try XCTUnwrap(v["password"] as? String)
            XCTAssertEqual(Self.hex(Data(password.precomposedStringWithCanonicalMapping.utf8)), v["passwordNfcUtf8Hex"] as? String)
            let salt = try XCTUnwrap(Data(base64Encoded: v["saltB64"] as! String))
            let it = try XCTUnwrap(v["iterations"] as? Int)
            let key = LockCrypto.deriveKey(password, salt: salt, iterations: it)
            XCTAssertEqual(Self.hex(key), v["keyHex"] as? String, password)
            XCTAssertEqual(LockCrypto.keyCheck(key).base64EncodedString(), v["checkB64"] as? String)
            XCTAssertEqual(LockCrypto.recoveryCode(key), v["recoveryCode"] as? String)
            XCTAssertEqual(LockCrypto.fromRecoveryCode(v["recoveryCode"] as! String), key)
            XCTAssertEqual(LockCrypto.fromRecoveryCode((v["recoveryCode"] as! String).lowercased().replacingOccurrences(of: "-", with: " ")), key)
            XCTAssertEqual(Self.hex(LockCrypto.subKey(key, .seal)), v["sealKeyHex"] as? String)
            XCTAssertEqual(Self.hex(LockCrypto.subKey(key, .file)), v["fileKeyHex"] as? String)
            XCTAssertEqual(Self.hex(LockCrypto.subKey(key, .names)), v["namesKeyHex"] as? String)
            let name = try XCTUnwrap(v["name"] as? String)
            XCTAssertEqual("pages/\(LockCrypto.lockedName(key, v["pageKey"] as! String)).ink.json", name)
            let plain = Data((v["plaintext"] as! String).utf8)
            let nonce = try XCTUnwrap(Data(base64Encoded: v["nonceB64"] as! String))
            let sealed = try LockCrypto.seal(key, name: name, plain, nonce: nonce)
            XCTAssertEqual(String(decoding: sealed, as: UTF8.self), v["envelope"] as? String)
            let env = try XCTUnwrap(LockCrypto.envelope(Data((v["envelope"] as! String).utf8)))
            XCTAssertEqual(env.version, 2)
            XCTAssertEqual(Self.hex(env.c), v["cipherAndTagHex"] as? String)
            XCTAssertEqual(try LockCrypto.unseal(key, env), plain)
            XCTAssertEqual(try LockSteps.openChecked(key, name: name, env), plain)
            // A changed byte, another key, or another name does not open it.
            var bad = env
            bad.c[0] ^= 1
            XCTAssertThrowsError(try LockCrypto.unseal(key, bad))
            XCTAssertThrowsError(try LockCrypto.unseal(Data(repeating: 7, count: 32), env))
            var moved = env
            moved.f = "pages/aaaaaaaaaaaaaaaa.ink.json"
            XCTAssertThrowsError(try LockCrypto.unseal(key, moved))
            XCTAssertThrowsError(try LockSteps.openChecked(key, name: "pages/aaaaaaaaaaaaaaaa.ink.json", env))
            // The lock file's MAC.
            let lock = LockFile(kdf: .init(iterations: it, salt: v["saltB64"] as! String), check: v["checkB64"] as! String,
                                state: v["lockState"] as! String)
            XCTAssertEqual(lock.macText, v["lockMacText"] as? String)
            XCTAssertEqual(lock.signed(key).mac, v["lockMacB64"] as? String)
            XCTAssertTrue(lock.signed(key).verify(key))
            // Version 1, read only to move a place to version 2.
            XCTAssertEqual(String(decoding: try LockCrypto.sealV1(key, plain, nonce: nonce), as: UTF8.self), v["v1Envelope"] as? String)
            let v1 = try XCTUnwrap(LockCrypto.envelope(Data((v["v1Envelope"] as! String).utf8)))
            XCTAssertEqual(try LockCrypto.unseal(key, v1), plain)
        }
    }

    func testPlainNamesMatchTheExtension() throws {
        let names = try XCTUnwrap(try vectorFile()["plainNames"] as? [[String: String]])
        XCTAssertGreaterThan(names.count, 3)
        for n in names { XCTAssertEqual(PlainName.hash(n["key"]!), n["hash"], n["key"]!) }
    }

    func testAPlainRecordIsNotAnEnvelope() {
        XCTAssertNil(LockCrypto.envelope(Data("{\n  \"v\": 1,\n  \"lock\": 1\n}\n".utf8)))
        XCTAssertNil(LockCrypto.envelope(Data("{\"lock\":1,\"alg\":\"other\",\"n\":\"\",\"c\":\"\"}".utf8)))
        XCTAssertNil(LockCrypto.envelope(Data("{\"lock\":2,\"alg\":\"A256GCM\",\"n\":\"\",\"c\":\"\"}".utf8)))
        XCTAssertNil(LockCrypto.fromRecoveryCode("short"))
    }

    /// A lock with the lowest count the format allows, so tests stay quick.
    func quickLock(_ password: String = "a long password") -> (LockFile, Data) {
        let salt = LockCrypto.random(16)
        let key = LockCrypto.deriveKey(password, salt: salt, iterations: 100_000)
        let l = LockFile(kdf: .init(iterations: 100_000, salt: salt.base64EncodedString()),
                         check: LockCrypto.keyCheck(key).base64EncodedString(), state: "turning-on")
        return (l.signed(key), key)
    }

    func testLockFileParsing() {
        let (l, key) = LockFile.new(password: "a long password")
        XCTAssertEqual(LockFile.parse(l.text), .lock(l))
        XCTAssertTrue(l.verify(key))
        XCTAssertNotNil(l.unlock(key))
        XCTAssertNil(l.unlock(Data(repeating: 1, count: 32)))
        XCTAssertEqual(l.kdf.iterations, 600_000)
        XCTAssertEqual(LockFile.parse(Data("{\"v\":1}".utf8)), .bad)
        var low = l
        low.kdf.iterations = 1000
        XCTAssertEqual(LockFile.parse(low.text), .bad)
    }

    func testAnEmptyOrShortSaltOrAMissingMacIsRefused() {
        let (l, _) = quickLock()
        for salt in ["", "AAAA"] {
            var bad = l
            bad.kdf.salt = salt
            XCTAssertEqual(LockFile.parse(bad.text), .bad, salt)
        }
        var noMac = l
        noMac.mac = nil
        XCTAssertEqual(LockFile.parse(noMac.text), .bad)
    }

    func testAnyFieldChangedWithoutTheKeyFailsTheMac() {
        let (l, key) = quickLock()
        var off = l
        off.state = "turning-off"
        XCTAssertFalse(off.verify(key))
        var v1 = l
        v1.v = 1
        XCTAssertFalse(v1.verify(key))
    }

    func testADeviceNeverTurnsTheLockOffByItself() {
        let (l, key) = quickLock()
        var on = l
        on.state = "on"
        on = on.signed(key)
        let held = HeldKey(key: key.base64EncodedString(), check: l.check, kdf: l.kdf, state: "on")
        XCTAssertEqual(LockSteps.judge(.none, nil), .plain)
        XCTAssertEqual(LockSteps.judge(.lock(on), nil), .needsPassword)
        XCTAssertEqual(LockSteps.judge(.none, held), .trouble("missing"))
        XCTAssertEqual(LockSteps.judge(.bad, held), .trouble("changed"))
        XCTAssertEqual(LockSteps.judge(.lock(on), held), .ready(on, work: false))
        var forged = on
        forged.state = "turning-off"
        XCTAssertEqual(LockSteps.judge(.lock(forged), held), .trouble("changed"), "Edited without the key")
        let signedOff = forged.signed(key)
        XCTAssertEqual(LockSteps.judge(.lock(signedOff), held), .trouble("changed"), "Not started on this device")
        var mine = held
        mine.state = "turning-off"
        XCTAssertEqual(LockSteps.judge(.lock(signedOff), mine), .ready(signedOff, work: true))
        XCTAssertEqual(LockSteps.judge(.lock(l), held), .trouble("changed"), "An old turning-on file put back")
    }

    func page(_ url: String) -> Data { recordJSON(key: url, notes: [note("n-\(url.count)")]) }

    func names(_ io: DirectoryIO) async throws -> [String] { try await io.list("pages").map(\.name).sorted() }

    func testTurningOnAndOffRenamesIsResumableAndNeverTouchesAFileItCannotOpen() async throws {
        let io = DirectoryIO(DirectoryStore(root: try tempDir(self), coordinated: false))
        let a = page("https://a.example/")
        let b = page("https://b.example/")
        let na = "pages/\(PlainName.hash("https://a.example/")).ink.json"
        let nb = "pages/\(PlainName.hash("https://b.example/")).ink.json"
        try await io.write(na, a)
        try await io.write(nb, b)
        // A file sealed with another key.
        let otherKey = Data(repeating: 9, count: 32)
        let nc = "pages/\(LockCrypto.lockedName(otherKey, "https://c.example/")).ink.json"
        let other = try LockCrypto.seal(otherKey, name: nc, page("https://c.example/"))
        try await io.write(nc, other)

        let (l, key) = quickLock()
        try await io.write(LockFile.name, l.text)
        let ka = "pages/\(LockCrypto.lockedName(key, "https://a.example/")).ink.json"
        let kb = "pages/\(LockCrypto.lockedName(key, "https://b.example/")).ink.json"
        // Stopped halfway: a is sealed under its new name, b is still plain.
        try await io.write(ka, try LockCrypto.seal(key, name: ka, a))
        try await io.remove(na)
        var p = try await LockSteps.settle(io, l, key)
        XCTAssertEqual(p.done, 1)
        guard case .lock(let on) = try await LockSteps.read(io) else { return XCTFail("no lock") }
        XCTAssertEqual(on.state, "on")
        XCTAssertTrue(on.verify(key))
        let locked = try await names(io)
        XCTAssertEqual(locked, [ka, kb, nc].sorted())
        XCTAssertFalse(locked.contains(nb), "No name the provider can link to a page")
        let sb = try await io.read(kb)
        XCTAssertEqual(LockSteps.open(sb, key: key, name: kb), b)
        XCTAssertNil(LockSteps.open(sb, key: nil, name: kb), "Sealed files are locked without the key")
        XCTAssertNil(LockSteps.open(sb, key: key, name: ka), "A file under another page's name does not open")

        var off = on
        off.state = "turning-off"
        off = try await LockSteps.write(io, off, key: key)
        p = try await LockSteps.settle(io, off, key)
        XCTAssertEqual(p.skipped, [nc])
        let plainNames = try await names(io)
        XCTAssertEqual(plainNames, [na, nb, nc].sorted())
        let ra = try await io.read(na)
        XCTAssertEqual(ra, a)
        let rc = try await io.read(nc)
        XCTAssertEqual(rc, other, "A file it cannot open is never written over")
        // With a file it cannot open, the lock file stays, so the lock is not lost.
        guard case .lock = try await LockSteps.read(io) else { return XCTFail("lock file removed") }
        try await io.remove(nc)
        _ = try await LockSteps.settle(io, off, key)
        let gone = try await LockSteps.read(io)
        XCTAssertEqual(gone, LockFile.Read.none)
    }

    func testResumeLeavesTheFilesAloneWhenTheLockFileWasRemovedOrForged() async throws {
        let io = DirectoryIO(DirectoryStore(root: try tempDir(self), coordinated: false))
        let secrets = MemorySecrets()
        let (l, key) = quickLock()
        try await io.write(LockFile.name, l.text)
        try await io.write("pages/x.ink.json", page("https://a.example/"))
        try secrets.setJSON(HeldKey.secret, l.unlock(key)!)
        var onLock = l
        onLock.state = "on"
        let first = try await LockSteps.resume(io, secrets: secrets)
        XCTAssertEqual(first, .ready(onLock, work: false))
        let before = try await names(io)
        let sealed = try await io.read(before[0])
        // Someone sets the lock file to turning off without the key.
        guard case .lock(var forged) = try await LockSteps.read(io) else { return XCTFail("no lock") }
        forged.state = "turning-off"
        try await io.write(LockFile.name, forged.text)
        let second = try await LockSteps.resume(io, secrets: secrets)
        XCTAssertEqual(second, .trouble("changed"))
        let after1 = try await io.read(before[0])
        XCTAssertEqual(after1, sealed)
        // Someone removes the lock file.
        try await io.remove(LockFile.name)
        let third = try await LockSteps.resume(io, secrets: secrets)
        XCTAssertEqual(third, .trouble("missing"))
        let after2 = try await io.read(before[0])
        XCTAssertEqual(after2, sealed)
        XCTAssertNotNil(secrets.getJSON(HeldKey.secret, HeldKey.self), "The key is kept until the reader chooses")
    }

    func testAPlaceLockedWithVersionOneMovesToVersionTwoAndPlainFilesStayOut() async throws {
        let io = DirectoryIO(DirectoryStore(root: try tempDir(self), coordinated: false))
        var (l, key) = quickLock()
        l.v = 1
        l.mac = nil
        l.state = "on"
        try await io.write(LockFile.name, l.text)
        try await io.write("pages/a.ink.json", try LockCrypto.sealV1(key, page("https://a.example/")))
        try await io.write("pages/b.ink.json", page("https://b.example/"))
        let p = try await LockSteps.settle(io, l, key)
        XCTAssertEqual(p.done, 1)
        XCTAssertEqual(p.refused, ["pages/b.ink.json"])
        guard case .lock(let now) = try await LockSteps.read(io) else { return XCTFail("no lock") }
        XCTAssertEqual(now.v, 2)
        XCTAssertTrue(now.verify(key))
    }

    /// The lock key and the tokens live in the keychain, in the App Group's access group, which
    /// only this app and its own Safari extension can read, on this device only.
    func testSecretsStayInTheAppGroupKeychainOnThisDevice() throws {
        let k = KeychainStore(service: "shared-test.cloud", group: "shared-test")
        let q = k.base(HeldKey.secret)
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String, "shared-test")
        XCTAssertEqual(q[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertNil(q[kSecAttrSynchronizable as String])
        XCTAssertEqual(KeychainStore.accessible as String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        // No target asks for any other keychain group, and each shares only its App Group.
        let config = Self.repo.appendingPathComponent("apple/Config")
        for f in try FileManager.default.contentsOfDirectory(atPath: config.path) where f.hasSuffix(".entitlements") {
            let o = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: config.appendingPathComponent(f)), format: nil) as? [String: Any])
            XCTAssertNil(o["keychain-access-groups"], f)
            // The Mac build signed to run locally shares a folder and no group (SharedSpaceTests).
            let groups = f == "Local-macOS.entitlements" ? nil : ["$(INK_APP_GROUP)"]
            XCTAssertEqual(o["com.apple.security.application-groups"] as? [String], groups, f)
        }
        // Nothing else in the app's sources touches the keychain or asks for synced items.
        for dir in ["apple/Shared", "apple/App", "apple/Extension"] {
            let root = Self.repo.appendingPathComponent(dir)
            for f in try FileManager.default.contentsOfDirectory(atPath: root.path) where f.hasSuffix(".swift") {
                let text = try String(contentsOf: root.appendingPathComponent(f), encoding: .utf8)
                XCTAssertFalse(text.contains("kSecAttrSynchronizable"), f)
                if f != "Secrets.swift" { XCTAssertFalse(text.contains("SecItem"), f) }
            }
        }
    }

    func testLibraryOpensSealedFilesWithTheKeptKey() throws {
        let space = SharedSpace(root: try tempDir(self))
        let (l, key) = LockFile.new(password: "a long password")
        let name = "pages/\(LockCrypto.lockedName(key, "https://a.example/")).ink.json"
        try space.store().write(name, try LockCrypto.seal(key, name: name, recordJSON(key: "https://a.example/", title: "Sealed", notes: [note("n1")])))
        XCTAssertEqual(Library.load(space.store()).pages.count, 0)
        let lib = Library.load(space.store(), key: l.unlock(key)?.bytes)
        XCTAssertEqual(lib.pages.first?.title, "Sealed")
    }
}
