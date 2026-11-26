import Foundation

/// When the app may ask for an App Store rating. App Store Review Guideline 5.6.1 allows only
/// the system's own review prompt (StoreKit), so the Safari popup shows no line of its own and
/// the app asks through StoreKit instead. The system decides whether the prompt really shows,
/// and shows it at most three times a year.
///
/// The rule is the extension's (packages/extension/src/rate.ts): ink on at least `pages`
/// different pages, and at least `days` days since the first note, so the reader has come back
/// on another day. On top of that the app asks at most once per version, and only after the
/// Notes list has been on screen for a moment (LibraryView), never as the result of a tap.
public enum ReviewRule {
    public static let pages = 5
    public static let days: Double = 3
    /// How long the Notes list stays on screen, with nothing else going on, before the app asks.
    /// Long enough that the prompt never comes as the app opens or right after a tap.
    public static let settle: Duration = .seconds(10)

    /// The earliest note on any page, or the oldest page change when no note has a time.
    public static func firstUse(_ list: [PageSummary]) -> Date? {
        let notes = list.flatMap(\.notes).map(\.createdAt).filter { $0 > 0 }
        if let ms = notes.min() { return Date(timeIntervalSince1970: ms / 1000) }
        let pages = list.map(\.record.updatedAt).filter { $0 > 0 }
        return pages.min().map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// True when the app may ask now. Pure.
    public static func due(pageCount: Int, firstUse: Date?, askedVersion: String, version: String, now: Date) -> Bool {
        guard pageCount >= pages, !version.isEmpty, askedVersion != version else { return false }
        // A first note in the future means a clock moved. Wait until it makes sense again.
        guard let first = firstUse, first <= now else { return false }
        return now.timeIntervalSince(first) >= days * 24 * 60 * 60
    }

    public static func due(_ list: [PageSummary], askedVersion: String, version: String, now: Date) -> Bool {
        let inked = list.filter { !$0.notes.isEmpty }
        return due(pageCount: inked.count, firstUse: firstUse(inked), askedVersion: askedVersion, version: version, now: now)
    }
}
