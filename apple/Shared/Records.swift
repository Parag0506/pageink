import Foundation

/// The parts of a stroke the app draws. FORMAT.md, "Stroke".
public struct InkStroke: Equatable, Sendable {
    public var id: String
    public var t: Double
    public var tool: String
    public var color: String
    public var d: String
}

/// The parts of a note the app shows. FORMAT.md, "Note".
public struct InkNote: Equatable, Sendable {
    public var id: String
    public var kind: String
    public var createdAt: Double
    public var updatedAt: Double
    public var quote: String
    public var link: String?
    public var posStart: Int
    public var markStyle: String?
    public var strokes: [InkStroke]
}

/// One page record as read from a `.ink.json` file. Unknown fields are ignored.
public struct InkRecord: Equatable, Sendable {
    public var key: String
    public var title: String
    public var urls: [String]
    public var updatedAt: Double
    public var notes: [InkNote]
    public var deleted: [String: Double]
}

public enum RecordError: Error, Equatable {
    case notJSON
    case notRecord(String)
}

public enum RecordParser {
    public static func parse(_ data: Data) throws -> InkRecord {
        guard let obj = try? JSONSerialization.jsonObject(with: data), let o = obj as? [String: Any] else {
            throw RecordError.notJSON
        }
        return try parse(o)
    }

    public static func parse(_ o: [String: Any]) throws -> InkRecord {
        guard num(o["v"]) == 1 else { throw RecordError.notRecord("v") }
        guard let key = o["key"] as? String, !key.isEmpty else { throw RecordError.notRecord("key") }
        guard let rawNotes = o["notes"] as? [Any] else { throw RecordError.notRecord("notes") }
        var deleted: [String: Double] = [:]
        for case let t as [String: Any] in (o["deleted"] as? [Any]) ?? [] {
            if let id = t["id"] as? String { deleted[id] = num(t["t"]) ?? 0 }
        }
        var notes: [InkNote] = []
        for case let n as [String: Any] in rawNotes {
            guard let id = n["id"] as? String else { continue }
            let anchor = n["anchor"] as? [String: Any] ?? [:]
            let quote = (anchor["quote"] as? [String: Any])?["exact"] as? String ?? ""
            let pos = (anchor["pos"] as? [String: Any])?["start"]
            var strokes: [InkStroke] = []
            for case let s as [String: Any] in (n["strokes"] as? [Any]) ?? [] {
                guard let sid = s["id"] as? String, let d = s["d"] as? String else { continue }
                strokes.append(InkStroke(id: sid, t: num(s["t"]) ?? 0, tool: s["tool"] as? String ?? "pen",
                                         color: s["color"] as? String ?? "ink-1", d: d))
            }
            notes.append(InkNote(
                id: id,
                kind: n["kind"] as? String ?? "ink",
                createdAt: num(n["createdAt"]) ?? 0,
                updatedAt: num(n["updatedAt"]) ?? 0,
                quote: quote,
                link: anchor["link"] as? String,
                posStart: Int(num(pos) ?? 0),
                markStyle: (n["mark"] as? [String: Any])?["style"] as? String,
                strokes: strokes
            ))
        }
        return InkRecord(
            key: key,
            title: o["title"] as? String ?? "",
            urls: (o["urls"] as? [Any])?.compactMap { $0 as? String } ?? [],
            updatedAt: num(o["updatedAt"]) ?? 0,
            notes: notes,
            deleted: deleted
        )
    }

    static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
}

extension InkNote {
    /// True when the note draws something. The merge rule can leave an ink note with no
    /// strokes: it shows nothing and is not counted. Mirrors `showsInk` in pageink-core.
    public var showsInk: Bool { kind == "textmark" || !strokes.isEmpty }
}

extension InkRecord {
    /// Notes left after removals, as FORMAT.md "Merge" leaves them, without the ones that show nothing.
    public var liveNotes: [InkNote] {
        Self.merge(self, self).notes.filter(\.showsInk)
    }

    /// The id a note was first written under, before a deletion renamed what was left of it.
    public static func rootOf(_ id: String) -> String {
        guard let i = id.firstIndex(of: "~") else { return id }
        return String(id[..<i])
    }

    /// Id of the note that holds strokes written after a deletion at time t: `<first id>~<t in base 36>`.
    public static func laterId(_ id: String, _ t: Double) -> String {
        "\(rootOf(id))~\(String(Int64(t), radix: 36))"
    }

    /// FORMAT.md "Merge", as `merge` in pageink-core's store/merge.ts does it. Used for display only:
    /// the app never writes a merged record, the extension does.
    public static func merge(_ a: InkRecord, _ b: InkRecord) -> InkRecord {
        var tomb = a.deleted
        for (id, t) in b.deleted { tomb[id] = max(tomb[id] ?? t, t) }

        var groups: [String: [InkNote]] = [:]
        var order: [String] = []
        for n in a.notes + b.notes {
            let r = rootOf(n.id)
            if groups[r] == nil { order.append(r) }
            groups[r, default: []].append(n)
        }
        // Latest deletion per group. Stroke ids never share a root with a note.
        var cut: [String: Double] = [:]
        for (id, t) in tomb {
            let r = rootOf(id)
            guard groups[r] != nil else { continue }
            cut[r] = max(cut[r] ?? t, t)
        }

        var out: [InkNote] = []
        // One note from copies: fields from the newest copy written after `after`, strokes the
        // union minus tombstones and minus strokes written at or before `after`.
        func fold(_ id: String, _ list: [InkNote], after: Double = -Double.infinity) {
            var fields: InkNote?
            var strokes: [String: InkStroke] = [:]
            for n in list {
                let t = n.strokes.reduce(n.updatedAt) { max($0, $1.t) }
                if t <= after { continue }
                if fields == nil || t > fields!.updatedAt || (t == fields!.updatedAt && n.createdAt > fields!.createdAt) {
                    var f = n
                    f.updatedAt = t
                    fields = f
                }
                for s in n.strokes where tomb[s.id] == nil && s.t > after { strokes[s.id] = strokes[s.id] ?? s }
            }
            guard var note = fields else { return }
            note.id = id
            note.strokes = strokes.values.sorted { $0.t != $1.t ? $0.t < $1.t : $0.id < $1.id }
            out.append(note)
        }

        for root in order {
            let list = groups[root]!
            if let t = cut[root] {
                fold(laterId(root, t), list, after: t)
                continue
            }
            var ids: [String] = []
            var byNote: [String: [InkNote]] = [:]
            for n in list {
                if byNote[n.id] == nil { ids.append(n.id) }
                byNote[n.id, default: []].append(n)
            }
            for id in ids { fold(id, byNote[id]!) }
        }
        out.sort { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id }

        var rec = a.updatedAt >= b.updatedAt ? a : b
        rec.notes = out
        rec.deleted = tomb
        rec.urls = Array(NSOrderedSet(array: a.urls + b.urls)) as? [String] ?? a.urls
        rec.updatedAt = max(a.updatedAt, b.updatedAt)
        return rec
    }

    /// The address to open: the key when it is a web address, else the first web address in `urls`.
    /// Mirrors `addresses()` in pageink-core's store/identity.ts.
    public var address: String {
        if Self.isWeb(key) { return key }
        return urls.first { !$0.hasPrefix("host:") && Self.isWeb($0) } ?? key
    }

    public var host: String {
        URL(string: address)?.host ?? address
    }

    static func isWeb(_ s: String) -> Bool {
        let l = s.lowercased()
        return (l.hasPrefix("http://") || l.hasPrefix("https://")) && URL(string: s)?.host != nil
    }

    /// Joins another copy of the same page, as FORMAT.md "Merge" does, for display only.
    public func folded(with other: InkRecord) -> InkRecord { Self.merge(self, other) }
}

/// One page as the library shows it, built from every file that holds its key.
public struct PageSummary: Identifiable, Equatable, Sendable {
    public var id: String { record.key }
    public var record: InkRecord
    /// Files that hold this page: the canonical one and any conflict copies.
    public var files: [String]

    public var title: String {
        let t = record.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? record.address : t
    }
    public var notes: [InkNote] { record.liveNotes }
    public var updated: Date { Date(timeIntervalSince1970: record.updatedAt / 1000) }
}

public enum Library {
    /// Reads every record in `pages/` and groups copies by key. Pages without notes are left out.
    /// Files sealed by the password lock are opened with `key`. One the key does not open is
    /// listed in `locked`, not as damaged.
    public static func load(_ store: DirectoryStore, key: Data? = nil) -> (pages: [PageSummary], errors: [String], locked: [String]) {
        var errors: [String] = []
        var locked: [String] = []
        var byKey: [String: PageSummary] = [:]
        let entries: [FileEntry]
        do {
            entries = try store.list("pages")
        } catch {
            return ([], ["pages: \(error)"], [])
        }
        for e in entries where e.name.hasSuffix(".json") && !e.placeholder {
            do {
                guard let data = LockSteps.open(try store.read(e.name), key: key, name: e.name) else {
                    locked.append(e.name)
                    continue
                }
                let rec = try RecordParser.parse(data)
                if var have = byKey[rec.key] {
                    have.record = have.record.folded(with: rec)
                    have.files.append(e.name)
                    byKey[rec.key] = have
                } else {
                    byKey[rec.key] = PageSummary(record: rec, files: [e.name])
                }
            } catch {
                errors.append(e.name)
            }
        }
        let pages = byKey.values.filter { !$0.notes.isEmpty }.sorted { $0.record.updatedAt > $1.record.updatedAt }
        return (pages, errors, locked)
    }

    /// Matches title, address and quotes, ignoring case and accents.
    public static func matches(_ page: PageSummary, _ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return true }
        let opts: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        if page.title.range(of: q, options: opts) != nil { return true }
        if page.record.address.range(of: q, options: opts) != nil { return true }
        return page.notes.contains { $0.quote.range(of: q, options: opts) != nil }
    }
}

public enum RecordEditor {
    /// A copy of the record with every note removed the way the extension removes notes
    /// (FORMAT.md "Ids and changes"): each note and stroke id goes into `deleted` with a time
    /// never older than the newest stroke of its note, and an id already there keeps the later
    /// time. The record stays, so a merge with any other copy drops the ink too.
    /// Deleting the file alone would not work, because the extension would write it back.
    public static func removingAllNotes(_ data: Data, now: Date = Date()) throws -> Data {
        guard var o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw RecordError.notJSON
        }
        _ = try RecordParser.parse(o)
        let t = DirectoryStore.millis(now)
        var times: [String: Int64] = [:]
        var order: [String] = []
        let put = { (id: String, at: Int64) in
            if times[id] == nil { order.append(id) }
            times[id] = max(times[id] ?? at, at)
        }
        for case let d as [String: Any] in (o["deleted"] as? [Any]) ?? [] {
            if let id = d["id"] as? String { put(id, Int64(RecordParser.num(d["t"]) ?? 0)) }
        }
        for case let n as [String: Any] in (o["notes"] as? [Any]) ?? [] {
            var ids: [String] = []
            var newest = t
            if let id = n["id"] as? String { ids.append(id) }
            for case let s as [String: Any] in (n["strokes"] as? [Any]) ?? [] {
                if let id = s["id"] as? String { ids.append(id) }
                newest = max(newest, Int64(RecordParser.num(s["t"]) ?? 0))
            }
            for id in ids { put(id, newest) }
        }
        o["notes"] = [Any]()
        o["deleted"] = order.map { ["id": $0, "t": NSNumber(value: times[$0]!)] as [String: Any] }
        o["updatedAt"] = NSNumber(value: max(t, Int64(RecordParser.num(o["updatedAt"]) ?? 0) + 1))
        return try recordData(o)
    }

    /// Pretty JSON with a final newline, like the extension writes.
    static func recordData(_ o: [String: Any]) throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        data.append(0x0A)
        return data
    }
}
