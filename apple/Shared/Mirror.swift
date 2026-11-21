import Foundation

public struct MirrorReport: Equatable {
    public var toFolder = 0
    public var toStore = 0
    public var removed = 0
    public var conflicts = 0
    public var waiting = 0
    public var errors: [String] = []

    public init() {}

    public var changed: Bool { toFolder + toStore + removed + conflicts > 0 }
}

/// Two-way copy between the App Group store (side A) and the reader's folder (side B).
///
/// Per file: a side changed when its mtime differs from the one saved after the last mirror.
/// One side changed: copy it over. Both changed: the newer copy wins the name on both sides,
/// and the other copy is kept next to it as "<name> (conflicted copy <date>).ink.json".
/// The extension folds such copies into the record by key (FORMAT.md, "Backup folder"),
/// so no merging happens here. A file removed on one side and unchanged on the other is
/// removed on both. A file changed on one side and removed on the other comes back.
public struct Mirror {
    public let a: DirectoryStore
    public let b: DirectoryStore
    public var dir = "pages"

    public init(store: DirectoryStore, folder: DirectoryStore) {
        a = store
        b = folder
    }

    public func run(state: inout MirrorState, now: Date = Date()) -> MirrorReport {
        var report = MirrorReport()
        let listA: [FileEntry]
        let listB: [FileEntry]
        do {
            listA = try a.list(dir)
            listB = try b.list(dir)
        } catch let e as StoreError {
            report.errors.append("list: \(e.code)")
            return report
        } catch {
            report.errors.append("list: \(error.localizedDescription)")
            return report
        }
        let byA = Dictionary(listA.map { ($0.name, $0) }, uniquingKeysWith: { x, _ in x })
        let byB = Dictionary(listB.map { ($0.name, $0) }, uniquingKeysWith: { x, _ in x })
        let names = Set(byA.keys).union(byB.keys).union(state.files.keys.filter { $0.hasPrefix(dir + "/") })
        var next: [String: MirrorBase] = [:]
        // Names taken during this run, so two conflicts never pick the same copy name.
        var taken = Set(byA.keys).union(byB.keys)

        for name in names.sorted() {
            let ea = byA[name]
            let eb = byB[name]
            let base = state.files[name]
            if ea?.placeholder == true || eb?.placeholder == true {
                // Content not on this device yet. Leave it for a later mirror.
                if eb?.placeholder == true { b.startDownload(name) }
                if ea?.placeholder == true { a.startDownload(name) }
                if let base { next[name] = base }
                report.waiting += 1
                continue
            }
            do {
                switch (ea, eb) {
                case let (ea?, eb?):
                    let changedA = base?.a != ea.mtime
                    let changedB = base?.b != eb.mtime
                    if !changedA && !changedB {
                        next[name] = MirrorBase(a: ea.mtime, b: eb.mtime)
                    } else if changedA && !changedB {
                        next[name] = try copy(name, from: a, to: b, entry: ea, aToB: true, report: &report)
                    } else if changedB && !changedA {
                        next[name] = try copy(name, from: b, to: a, entry: eb, aToB: false, report: &report)
                    } else {
                        let da = try a.read(name)
                        let db = try b.read(name)
                        if da == db {
                            next[name] = MirrorBase(a: ea.mtime, b: eb.mtime)
                            continue
                        }
                        // Both changed. The newer wins; ties go to the store.
                        let aWins = ea.mtime >= eb.mtime
                        let loser = aWins ? db : da
                        let loserTime = aWins ? eb.mtime : ea.mtime
                        let copyName = Self.conflictName(name, date: now, taken: taken)
                        taken.insert(copyName)
                        try a.write(copyName, loser, mtime: loserTime)
                        try b.write(copyName, loser, mtime: loserTime)
                        next[copyName] = try pair(copyName)
                        report.conflicts += 1
                        if aWins {
                            next[name] = try copy(name, from: a, to: b, entry: ea, aToB: true, report: &report)
                        } else {
                            next[name] = try copy(name, from: b, to: a, entry: eb, aToB: false, report: &report)
                        }
                    }
                case let (ea?, nil):
                    if let base, base.b != nil, base.a == ea.mtime {
                        try a.remove(name)
                        report.removed += 1
                    } else {
                        next[name] = try copy(name, from: a, to: b, entry: ea, aToB: true, report: &report)
                    }
                case let (nil, eb?):
                    if let base, base.a != nil, base.b == eb.mtime {
                        try b.remove(name)
                        report.removed += 1
                    } else {
                        next[name] = try copy(name, from: b, to: a, entry: eb, aToB: false, report: &report)
                    }
                case (nil, nil):
                    break
                }
            } catch let e as StoreError {
                report.errors.append("\(name): \(e.code)")
                if let base { next[name] = base }
            } catch {
                report.errors.append("\(name): \(error.localizedDescription)")
                if let base { next[name] = base }
            }
        }
        state.files = next
        state.lastMirror = now
        return report
    }

    private func copy(_ name: String, from: DirectoryStore, to: DirectoryStore, entry: FileEntry,
                      aToB: Bool, report: inout MirrorReport) throws -> MirrorBase {
        let data = try from.read(name)
        try to.write(name, data, mtime: entry.mtime)
        if aToB { report.toFolder += 1 } else { report.toStore += 1 }
        return try pair(name)
    }

    private func pair(_ name: String) throws -> MirrorBase {
        MirrorBase(a: try a.entry(name)?.mtime, b: try b.entry(name)?.mtime)
    }

    /// "pages/abc.ink.json" becomes "pages/abc (conflicted copy 2026-11-16 1530).ink.json".
    public static func conflictName(_ name: String, date: Date, taken: Set<String> = []) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd HHmm"
        let stamp = f.string(from: date)
        let ext = name.hasSuffix(".ink.json") ? ".ink.json" : (name.hasSuffix(".json") ? ".json" : "")
        let stem = String(name.dropLast(ext.count))
        var candidate = "\(stem) (conflicted copy \(stamp))\(ext)"
        var n = 2
        while taken.contains(candidate) {
            candidate = "\(stem) (conflicted copy \(stamp) \(n))\(ext)"
            n += 1
        }
        return candidate
    }
}
