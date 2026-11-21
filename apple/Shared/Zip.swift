import Compression
import Foundation

/// A small zip reader and writer for note archives. Entries are stored or deflated.
/// No zip64, no encryption: archives of JSON notes stay far below 4 GB.
public enum Zip {
    public enum ZipError: Error, Equatable {
        case notZip
        case unsupported(String)
        case corrupt(String)
        case tooLarge
    }

    /// Limits for reading untrusted archives.
    public static let maxEntryBytes = 64 * 1024 * 1024
    public static let maxTotalBytes = 512 * 1024 * 1024

    // MARK: Writing

    public static func write(_ files: [(name: String, data: Data)], date: Date = Date()) -> Data {
        var out = Data()
        var central = Data()
        let (dosTime, dosDate) = dos(date)
        for f in files {
            let name = Data(f.name.utf8)
            let crc = crc32(f.data)
            var method: UInt16 = 0
            var body = f.data
            if let packed = deflate(f.data), packed.count < f.data.count {
                method = 8
                body = packed
            }
            let offset = UInt32(out.count)
            out.le32(0x0403_4B50)
            out.le16(20)
            out.le16(0x0800) // names are UTF-8
            out.le16(method)
            out.le16(dosTime)
            out.le16(dosDate)
            out.le32(crc)
            out.le32(UInt32(body.count))
            out.le32(UInt32(f.data.count))
            out.le16(UInt16(name.count))
            out.le16(0)
            out.append(name)
            out.append(body)

            central.le32(0x0201_4B50)
            central.le16(0x031E) // made by: Unix, version 3.0
            central.le16(20)
            central.le16(0x0800)
            central.le16(method)
            central.le16(dosTime)
            central.le16(dosDate)
            central.le32(crc)
            central.le32(UInt32(body.count))
            central.le32(UInt32(f.data.count))
            central.le16(UInt16(name.count))
            central.le16(0)
            central.le16(0)
            central.le16(0)
            central.le16(0)
            central.le32(0o100644 << 16)
            central.le32(offset)
            central.append(name)
        }
        let cdOffset = UInt32(out.count)
        out.append(central)
        out.le32(0x0605_4B50)
        out.le16(0)
        out.le16(0)
        out.le16(UInt16(files.count))
        out.le16(UInt16(files.count))
        out.le32(UInt32(central.count))
        out.le32(cdOffset)
        out.le16(0)
        return out
    }

    // MARK: Reading

    /// All file entries, read through the central directory. Folder entries are skipped.
    public static func read(_ zip: Data) throws -> [(name: String, data: Data)] {
        let b = [UInt8](zip)
        guard b.count >= 22 else { throw ZipError.notZip }
        // The end record sits in the last 22 + 65535 bytes.
        var eocd = -1
        var i = b.count - 22
        let stop = max(0, b.count - 22 - 65535)
        while i >= stop {
            if b.u32(i) == 0x0605_4B50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw ZipError.notZip }
        let count = Int(b.u16(eocd + 10))
        var p = Int(b.u32(eocd + 16))
        var out: [(String, Data)] = []
        var total = 0
        for _ in 0..<count {
            guard p + 46 <= b.count, b.u32(p) == 0x0201_4B50 else { throw ZipError.corrupt("central directory") }
            let flags = b.u16(p + 8)
            let method = b.u16(p + 10)
            let crc = b.u32(p + 16)
            let csize = Int(b.u32(p + 20))
            let usize = Int(b.u32(p + 24))
            let nlen = Int(b.u16(p + 28))
            let xlen = Int(b.u16(p + 30))
            let clen = Int(b.u16(p + 32))
            let local = Int(b.u32(p + 42))
            guard p + 46 + nlen <= b.count else { throw ZipError.corrupt("name") }
            let name = String(decoding: b[(p + 46)..<(p + 46 + nlen)], as: UTF8.self)
            p += 46 + nlen + xlen + clen
            if flags & 1 != 0 { throw ZipError.unsupported("encrypted entry") }
            if name.hasSuffix("/") { continue }
            guard usize <= maxEntryBytes else { throw ZipError.tooLarge }
            total += usize
            guard total <= maxTotalBytes else { throw ZipError.tooLarge }
            guard local + 30 <= b.count, b.u32(local) == 0x0403_4B50 else { throw ZipError.corrupt("local header") }
            let localName: Int = Int(b.u16(local + 26))
            let localExtra: Int = Int(b.u16(local + 28))
            let start: Int = local + 30 + localName + localExtra
            guard start + csize <= b.count else { throw ZipError.corrupt("entry size") }
            let raw = Data(b[start..<(start + csize)])
            let data: Data
            switch method {
            case 0: data = raw
            case 8:
                guard let d = inflate(raw, size: usize) else { throw ZipError.corrupt(name) }
                data = d
            default: throw ZipError.unsupported("method \(method)")
            }
            guard data.count == usize, crc32(data) == crc else { throw ZipError.corrupt(name) }
            out.append((name, data))
        }
        return out
    }

    // MARK: Deflate through the Compression framework (raw deflate, RFC 1951)

    static func deflate(_ data: Data) -> Data? {
        if data.isEmpty { return nil }
        let cap = data.count + 1024
        var dst = [UInt8](repeating: 0, count: cap)
        let n = data.withUnsafeBytes { src -> Int in
            guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_encode_buffer(&dst, cap, base, data.count, nil, COMPRESSION_ZLIB)
        }
        return n > 0 ? Data(dst[0..<n]) : nil
    }

    static func inflate(_ data: Data, size: Int) -> Data? {
        if size == 0 { return Data() }
        var dst = [UInt8](repeating: 0, count: size)
        let n = data.withUnsafeBytes { src -> Int in
            guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return compression_decode_buffer(&dst, size, base, data.count, nil, COMPRESSION_ZLIB)
        }
        return n == size ? Data(dst) : nil
    }

    // MARK: Helpers

    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    public static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for byte in data { c = crcTable[Int((c ^ UInt32(byte)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }

    private static func dos(_ date: Date) -> (UInt16, UInt16) {
        let c = Calendar(identifier: .gregorian).dateComponents(in: .current, from: date)
        // Each part is its own typed statement, so older compilers type-check it quickly.
        let year: Int = max(1980, c.year ?? 1980)
        let month: Int = c.month ?? 1
        let dayOfMonth: Int = c.day ?? 1
        let hour: Int = c.hour ?? 0
        let minute: Int = c.minute ?? 0
        let second: Int = c.second ?? 0
        let hourBits: Int = hour << 11
        let minuteBits: Int = minute << 5
        let secondBits: Int = second / 2
        let timeBits: Int = hourBits | minuteBits | secondBits
        let yearBits: Int = (year - 1980) << 9
        let monthBits: Int = month << 5
        let dayBits: Int = yearBits | monthBits | dayOfMonth
        let time = UInt16(truncatingIfNeeded: timeBits)
        let day = UInt16(truncatingIfNeeded: dayBits)
        return (time, day)
    }
}

private extension Data {
    mutating func le16(_ v: UInt16) { append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8)]) }
    mutating func le32(_ v: UInt32) {
        append(contentsOf: [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)])
    }
}

private extension Array where Element == UInt8 {
    func u16(_ i: Int) -> UInt16 { UInt16(self[i]) | UInt16(self[i + 1]) << 8 }
    func u32(_ i: Int) -> UInt32 {
        let b0: UInt32 = UInt32(self[i])
        let b1: UInt32 = UInt32(self[i + 1]) << 8
        let b2: UInt32 = UInt32(self[i + 2]) << 16
        let b3: UInt32 = UInt32(self[i + 3]) << 24
        return b0 | b1 | b2 | b3
    }
}
