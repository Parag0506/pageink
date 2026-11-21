import CoreGraphics
import Foundation

/// Stroke outline paths from the record format: only M, L, Q, C and Z, in either case.
/// The extension writes the first point absolute and the rest relative, with at most one decimal.
/// This reader follows `readPath` in pageink-core's strokes/path.ts.
public enum InkPath {
    public enum Segment: Equatable {
        case move(CGPoint)
        case line(CGPoint)
        case quad(CGPoint, CGPoint)
        case cubic(CGPoint, CGPoint, CGPoint)
        case close
    }

    private static let argCount: [Character: Int] = ["m": 2, "l": 2, "q": 4, "c": 6, "z": 0]

    /// Absolute segments. Unknown characters are skipped and a command with too few numbers is dropped.
    public static func parse(_ d: String) -> [Segment] {
        var out: [Segment] = []
        var cmd: Character = " "
        var buf: [CGFloat] = []
        var cur = CGPoint.zero
        var start = CGPoint.zero
        let chars = Array(d.utf8)
        var i = 0

        func flush() {
            let lower = Character(cmd.lowercased())
            let rel = cmd.isLowercase
            var p = buf
            buf = []
            if lower == "m" {
                let x = p[0] + (rel ? cur.x : 0)
                let y = p[1] + (rel ? cur.y : 0)
                cur = CGPoint(x: x, y: y)
                start = cur
                out.append(.move(cur))
                return
            }
            if rel {
                var k = 0
                while k + 1 < p.count {
                    p[k] += cur.x
                    p[k + 1] += cur.y
                    k += 2
                }
            }
            switch lower {
            case "l": out.append(.line(CGPoint(x: p[0], y: p[1])))
            case "q": out.append(.quad(CGPoint(x: p[0], y: p[1]), CGPoint(x: p[2], y: p[3])))
            default: out.append(.cubic(CGPoint(x: p[0], y: p[1]), CGPoint(x: p[2], y: p[3]), CGPoint(x: p[4], y: p[5])))
            }
            cur = CGPoint(x: p[p.count - 2], y: p[p.count - 1])
        }

        while i < chars.count {
            let c = chars[i]
            switch c {
            case UInt8(ascii: "M"), UInt8(ascii: "m"), UInt8(ascii: "L"), UInt8(ascii: "l"),
                 UInt8(ascii: "Q"), UInt8(ascii: "q"), UInt8(ascii: "C"), UInt8(ascii: "c"):
                cmd = Character(Unicode.Scalar(c))
                buf = []
                i += 1
            case UInt8(ascii: "Z"), UInt8(ascii: "z"):
                cmd = Character(Unicode.Scalar(c))
                buf = []
                out.append(.close)
                cur = start
                i += 1
            case UInt8(ascii: "+"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "0")...UInt8(ascii: "9"):
                let (value, next) = number(chars, i)
                i = next
                guard let value, cmd != " ", cmd != "z", cmd != "Z" else { continue }
                buf.append(value)
                let lower = Character(cmd.lowercased())
                if buf.count < argCount[lower, default: 2] { continue }
                flush()
                // Pairs after a moveto are implicit linetos.
                if lower == "m" { cmd = cmd == "m" ? "l" : "L" }
            default:
                i += 1
            }
        }
        return out
    }

    /// Reads one number in SVG syntax: sign, digits, a dot, digits, exponent.
    /// ".5.5" is two numbers and "1-2" is two numbers, as in SVG.
    private static func number(_ s: [UInt8], _ from: Int) -> (CGFloat?, Int) {
        var i = from
        if i < s.count && (s[i] == UInt8(ascii: "+") || s[i] == UInt8(ascii: "-")) { i += 1 }
        var digits = 0
        while i < s.count && s[i] >= UInt8(ascii: "0") && s[i] <= UInt8(ascii: "9") { i += 1; digits += 1 }
        if i < s.count && s[i] == UInt8(ascii: ".") {
            i += 1
            while i < s.count && s[i] >= UInt8(ascii: "0") && s[i] <= UInt8(ascii: "9") { i += 1; digits += 1 }
        }
        if digits == 0 { return (nil, max(i, from + 1)) }
        if i < s.count && (s[i] == UInt8(ascii: "e") || s[i] == UInt8(ascii: "E")) {
            var j = i + 1
            if j < s.count && (s[j] == UInt8(ascii: "+") || s[j] == UInt8(ascii: "-")) { j += 1 }
            var exp = 0
            while j < s.count && s[j] >= UInt8(ascii: "0") && s[j] <= UInt8(ascii: "9") { j += 1; exp += 1 }
            if exp > 0 { i = j }
        }
        let text = String(decoding: s[from..<i], as: UTF8.self)
        guard let v = Double(text) else { return (nil, i) }
        return (CGFloat(v), i)
    }

    public static func cgPath(_ segments: [Segment]) -> CGPath {
        let p = CGMutablePath()
        var open = false
        for s in segments {
            switch s {
            case .move(let a):
                p.move(to: a)
                open = true
            case .line(let a):
                if !open { p.move(to: .zero); open = true }
                p.addLine(to: a)
            case .quad(let c, let a):
                if !open { p.move(to: .zero); open = true }
                p.addQuadCurve(to: a, control: c)
            case .cubic(let c1, let c2, let a):
                if !open { p.move(to: .zero); open = true }
                p.addCurve(to: a, control1: c1, control2: c2)
            case .close:
                if open { p.closeSubpath() }
            }
        }
        return p
    }

    public static func cgPath(_ d: String) -> CGPath { cgPath(parse(d)) }
}
