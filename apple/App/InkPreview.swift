import SwiftUI

/// A small drawing of a page's ink, from the stored outline paths.
/// Up to three notes sit side by side, each scaled to fit its cell.
struct InkPreview: View {
    let notes: [InkNote]
    @Environment(\.colorScheme) private var scheme

    private struct Drawn {
        var paths: [(CGPath, String, Bool)]
        var box: CGRect
    }

    private var drawn: [Drawn] {
        let inked = notes.filter { !$0.strokes.isEmpty }.sorted { $0.updatedAt > $1.updatedAt }
        return inked.prefix(3).compactMap { n in
            var box = CGRect.null
            var paths: [(CGPath, String, Bool)] = []
            for s in n.strokes {
                let p = InkPath.cgPath(s.d)
                let b = p.boundingBoxOfPath
                guard !b.isNull, !b.isInfinite else { continue }
                box = box.union(b)
                paths.append((p, s.color, s.tool == "hi"))
            }
            return paths.isEmpty ? nil : Drawn(paths: paths, box: box)
        }
    }

    var body: some View {
        let items = drawn
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.04))
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08))
            if items.isEmpty {
                Image(systemName: "highlighter")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            } else {
                Canvas { ctx, size in
                    let pad: CGFloat = 6
                    let area = CGRect(origin: .zero, size: size).insetBy(dx: pad, dy: pad)
                    let n = CGFloat(items.count)
                    // Side by side suits tall notes and stacked suits wide ones. Use whichever draws larger.
                    func fit(_ cell: CGSize) -> CGFloat {
                        items.reduce(0) { $0 + min(cell.width / max($1.box.width, 1), cell.height / max($1.box.height, 1)) }
                    }
                    let stacked = fit(CGSize(width: area.width, height: area.height / n))
                        > fit(CGSize(width: area.width / n, height: area.height))
                    for (i, item) in items.enumerated() {
                        let k = CGFloat(i)
                        let cell = (stacked
                            ? CGRect(x: area.minX, y: area.minY + area.height / n * k, width: area.width, height: area.height / n)
                            : CGRect(x: area.minX + area.width / n * k, y: area.minY, width: area.width / n, height: area.height))
                            .insetBy(dx: 2, dy: 1)
                        let box = item.box
                        let scale = min(cell.width / max(box.width, 1), cell.height / max(box.height, 1))
                        let dx = cell.midX - box.midX * scale
                        let dy = cell.midY - box.midY * scale
                        let t = CGAffineTransform(translationX: dx, y: dy).scaledBy(x: scale, y: scale)
                        for (p, color, hi) in item.paths {
                            let path = Path(p).applying(t)
                            ctx.fill(path, with: .color(InkColors.color(color, hi: hi, dark: scheme == .dark).opacity(hi ? 0.55 : 1)))
                        }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Stroke colours by semantic name, the same palettes as pageink-core's render/theme.ts.
enum InkColors {
    static func color(_ name: String, hi: Bool, dark: Bool) -> Color {
        let light: [String: Int] = ["ink-1": 0x1F2A44, "ink-2": 0xD03A2F, "hi-1": 0xFFE14D, "hi-2": 0x8FE3A1]
        let night: [String: Int] = ["ink-1": 0xE8ECF4, "ink-2": 0xFF8A7A, "hi-1": 0x8C7A00, "hi-2": 0x1F7A3C]
        let table = dark ? night : light
        if let v = table[name] { return rgb(v) }
        if let v = hex(name) { return v }
        return rgb(table[hi ? "hi-1" : "ink-1"]!)
    }

    private static func rgb(_ v: Int) -> Color {
        let r: Double = Double((v >> 16) & 0xFF) / 255
        let g: Double = Double((v >> 8) & 0xFF) / 255
        let b: Double = Double(v & 0xFF) / 255
        return Color(.sRGB, red: r, green: g, blue: b)
    }

    /// Only "#rgb" and "#rrggbb", as the extension accepts.
    private static func hex(_ s: String) -> Color? {
        guard s.hasPrefix("#") else { return nil }
        let h = String(s.dropFirst())
        guard h.allSatisfy(\.isHexDigit) else { return nil }
        if h.count == 6, let v = Int(h, radix: 16) { return rgb(v) }
        if h.count == 3 {
            let full = h.map { "\($0)\($0)" }.joined()
            if let v = Int(full, radix: 16) { return rgb(v) }
        }
        return nil
    }
}
