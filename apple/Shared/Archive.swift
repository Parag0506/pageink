import Foundation

public struct ImportReport: Equatable {
    public var added = 0
    public var same = 0
    public var copies = 0
    public var skipped: [String] = []
    /// Names written into the store, for sending on to a cloud.
    public var written: [String] = []
}

/// Archives with the same layout as the backup folder: `pages/<hash>.ink.json` (FORMAT.md).
public enum Archive {
    /// Files sealed by the password lock go in opened when `key` opens them, so the archive
    /// stays readable without the app.
    public static func export(_ store: DirectoryStore, key: Data? = nil) throws -> Data {
        var files: [(name: String, data: Data)] = []
        for e in try store.list("pages") where e.name.hasSuffix(".json") && !e.placeholder {
            let d = try store.read(e.name)
            files.append((e.name, LockSteps.open(d, key: key, name: e.name) ?? d))
        }
        return Zip.write(files)
    }

    /// Puts each record from the archive into the store. A file that differs from the one already
    /// there is written next to it as a conflict copy, and the extension folds it in by key.
    public static func importArchive(_ zip: Data, into store: DirectoryStore, now: Date = Date()) throws -> ImportReport {
        var report = ImportReport()
        var taken = Set(try store.list("pages").map(\.name))
        for (name, data) in try Zip.read(zip) {
            guard name.hasPrefix("pages/"), name.hasSuffix(".json"), SafeName.isSafe(name),
                  name.split(separator: "/").count == 2 else {
                report.skipped.append(name)
                continue
            }
            guard (try? RecordParser.parse(data)) != nil else {
                report.skipped.append(name)
                continue
            }
            if taken.contains(name) {
                if (try? store.read(name)) == data {
                    report.same += 1
                    continue
                }
                let copy = Mirror.conflictName(name, date: now, taken: taken)
                try store.write(copy, data)
                taken.insert(copy)
                report.written.append(copy)
                report.copies += 1
            } else {
                try store.write(name, data)
                taken.insert(name)
                report.written.append(name)
                report.added += 1
            }
        }
        return report
    }
}

/// All notes as Markdown. Follows `toMarkdown` in pageink-core's store/markdown.ts.
public enum MarkdownExport {
    public static func render(_ pages: [PageSummary]) -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "UTC")
        fmt.dateFormat = "yyyy-MM-dd"
        let day = { (ms: Double) in fmt.string(from: Date(timeIntervalSince1970: ms / 1000)) }

        var parts: [String] = []
        let sorted = pages.filter { !$0.notes.isEmpty }.sorted { $0.record.updatedAt > $1.record.updatedAt }
        for p in sorted {
            let address = p.record.address
            let title = oneLine(p.record.title)
            var lines = ["## \(title.isEmpty ? address : title)", "", "<\(address)>", ""]
            let notes = p.notes.sorted {
                $0.posStart != $1.posStart ? $0.posStart < $1.posStart : $0.createdAt < $1.createdAt
            }
            for n in notes {
                let quote = oneLine(n.quote)
                if !quote.isEmpty { lines += ["> \(quote)", ""] }
                let kind = kindOf(n)
                lines.append("- \(kind.prefix(1).uppercased())\(kind.dropFirst()), \(day(n.createdAt))")
                if let link = n.link, !link.isEmpty { lines.append("- Link: <\(link)>") }
                lines.append("")
            }
            parts.append(lines.joined(separator: "\n"))
        }
        return parts.isEmpty ? "# Notes\n" : "# Notes\n\n" + parts.joined(separator: "\n")
    }

    static func kindOf(_ n: InkNote) -> String {
        if n.kind == "textmark" { return n.markStyle ?? "highlight" }
        return !n.strokes.isEmpty && n.strokes.allSatisfy { $0.tool == "hi" } ? "highlight" : "handwriting"
    }

    static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
