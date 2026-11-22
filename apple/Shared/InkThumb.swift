import CoreGraphics
import Foundation

/// One filled shape of a page's small drawing, in the note's own units.
public struct ThumbShape: Equatable {
    public enum Kind: Equatable, Sendable {
        /// A pen stroke.
        case pen
        /// A highlighter stroke, or the band of a highlight on text.
        case marker
        /// The line of an underline or a strike on text.
        case line
        /// Grey bars that stand for the words a text mark is on.
        case words
    }

    public var path: CGPath
    public var kind: Kind
    /// The stored colour: a semantic name or hex. Empty for `words`.
    public var color: String
}

/// What the Notes list draws for one note: its shapes in drawing order, and the box to fit.
public struct ThumbItem: Equatable {
    public var shapes: [ThumbShape]
    public var box: CGRect
}

/// The small drawing of a page's notes, as shapes. The app paints them; the tests read them.
public enum InkThumb {
    /// The newest notes that draw something, at most `limit`.
    public static func items(_ notes: [InkNote], limit: Int = 3) -> [ThumbItem] {
        var out: [ThumbItem] = []
        for n in notes.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            guard out.count < limit else { break }
            if let item = item(n) { out.append(item) }
        }
        return out
    }

    /// One note as shapes, or nil when it draws nothing.
    public static func item(_ n: InkNote) -> ThumbItem? {
        n.kind == "textmark" ? mark(n) : strokes(n)
    }

    // A text mark has no strokes (FORMAT.md, "Note"): it is a style and a colour on the quoted
    // words. The drawing stands for it: grey bars for the words, with the marker band behind
    // them or the line under or through them, as `markPath` in pageink-core places them.
    static let lineHeight: CGFloat = 14
    static let charWidth: CGFloat = 3
    /// Characters on one line, and in one bar.
    static let lineChars = 16
    static let wordChars = 12
    static let maxLines = 3

    private static func mark(_ n: InkNote) -> ThumbItem {
        let h = lineHeight
        let style = n.markStyle ?? "highlight"
        let highlight = style != "underline" && style != "strike"
        let color = n.markColor ?? (highlight ? "hi-1" : "ink-1")

        let words = CGMutablePath()
        let stroke = CGMutablePath()
        var width: CGFloat = 0
        let lines = wordLines(n.quote)
        for (i, line) in lines.enumerated() {
            let top = CGFloat(i) * h
            var x: CGFloat = 0
            for chars in line {
                let w = CGFloat(chars) * charWidth
                bar(words, CGRect(x: x, y: top + h * 0.38, width: w, height: h * 0.36))
                x += w + charWidth
            }
            let end = x - charWidth
            width = max(width, end)
            if highlight {
                bar(stroke, CGRect(x: -1, y: top + h * 0.04, width: end + 2, height: h * 0.94), radius: 2)
            } else {
                // An underline sits just under the words and a strike runs through their middle.
                let y = style == "underline" ? h * 0.86 : h * 0.56
                let thick = h * 0.12
                bar(stroke, CGRect(x: -1, y: top + y - thick / 2, width: end + 2, height: thick))
            }
        }
        let text = ThumbShape(path: words, kind: .words, color: "")
        let drawn = ThumbShape(path: stroke, kind: highlight ? .marker : .line, color: color)
        // The band goes under the words, a line goes over them.
        return ThumbItem(shapes: highlight ? [drawn, text] : [text, drawn],
                         box: CGRect(x: -1, y: 0, width: width + 2, height: CGFloat(lines.count) * h))
    }

    /// The quote as lines of bars, each a count of characters. Words over `wordChars` are cut
    /// into pieces, so text without spaces fills lines too. An empty quote is one short bar.
    static func wordLines(_ quote: String) -> [[Int]] {
        var lines: [[Int]] = [[]]
        var used = 0
        for word in quote.split(whereSeparator: \.isWhitespace) {
            var left = word.count
            while left > 0 {
                let n = min(left, wordChars)
                left -= n
                if !lines[lines.count - 1].isEmpty, used + n > lineChars {
                    if lines.count == maxLines { return lines }
                    lines.append([])
                    used = 0
                }
                lines[lines.count - 1].append(n)
                used += n + 1
            }
        }
        return lines[0].isEmpty ? [[8]] : lines
    }

    private static func bar(_ path: CGMutablePath, _ r: CGRect, radius: CGFloat? = nil) {
        let c = min(radius ?? r.height / 2, r.width / 2, r.height / 2)
        path.addRoundedRect(in: r, cornerWidth: c, cornerHeight: c)
    }

    private static func strokes(_ n: InkNote) -> ThumbItem? {
        var box = CGRect.null
        var shapes: [ThumbShape] = []
        for s in n.strokes {
            let p = InkPath.cgPath(s.d)
            let b = p.boundingBoxOfPath
            guard !b.isNull, !b.isInfinite else { continue }
            box = box.union(b)
            shapes.append(ThumbShape(path: p, kind: s.tool == "hi" ? .marker : .pen, color: s.color))
        }
        return shapes.isEmpty ? nil : ThumbItem(shapes: shapes, box: box)
    }
}

/// Stroke colours by semantic name, the same palettes as pageink-core's render/theme.ts.
public enum InkPalette {
    static let light: [String: Int] = ["ink-1": 0x1F2A44, "ink-2": 0xD03A2F, "hi-1": 0xFFE14D, "hi-2": 0x8FE3A1]
    static let dark: [String: Int] = ["ink-1": 0xE8ECF4, "ink-2": 0xFF8A7A, "hi-1": 0x8C7A00, "hi-2": 0x1F7A3C]

    /// The colour as 0xRRGGBB. An unknown name gives the first highlighter or pen colour.
    public static func rgb(_ name: String, hi: Bool, dark night: Bool) -> Int {
        let table = night ? dark : light
        if let v = table[name] { return v }
        if let v = hex(name) { return v }
        return table[hi ? "hi-1" : "ink-1"]!
    }

    /// Only "#rgb" and "#rrggbb", as the extension accepts.
    static func hex(_ s: String) -> Int? {
        guard s.hasPrefix("#") else { return nil }
        let h = String(s.dropFirst())
        guard h.allSatisfy(\.isHexDigit) else { return nil }
        if h.count == 6 { return Int(h, radix: 16) }
        if h.count == 3 { return Int(h.map { "\($0)\($0)" }.joined(), radix: 16) }
        return nil
    }
}
