import SwiftUI

/// A small drawing of a page's ink, from the shapes `InkThumb` makes of the notes.
/// Up to three notes sit side by side, each scaled to fit its cell.
struct InkPreview: View {
    let notes: [InkNote]
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let items = InkThumb.items(notes)
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
                        for shape in item.shapes {
                            let path = Path(shape.path).applying(t)
                            if shape.kind == .words {
                                ctx.fill(path, with: .color(Color.primary.opacity(0.4)))
                                continue
                            }
                            let hi = shape.kind == .marker
                            let color = InkColors.color(shape.color, hi: hi, dark: scheme == .dark)
                            ctx.fill(path, with: .color(color.opacity(hi ? 0.55 : 1)))
                        }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// Stroke colours for SwiftUI, from the palettes in `InkPalette`.
enum InkColors {
    static func color(_ name: String, hi: Bool, dark: Bool) -> Color {
        let v = InkPalette.rgb(name, hi: hi, dark: dark)
        return Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255,
                     blue: Double(v & 0xFF) / 255)
    }
}
