import Foundation

/// Names that arrive from the extension or from an archive are relative paths inside the store.
/// Anything that could reach outside the store is refused. See NATIVE_PROTOCOL.md, "Rules".
public enum SafeName {
    static let maxLength = 512

    /// The path components of a safe name, or nil when the name is not allowed.
    /// Hidden components are refused too: they hold temporary files and sync service state.
    public static func components(_ name: String) -> [String]? {
        if name.isEmpty || name.utf8.count > maxLength { return nil }
        if name.hasPrefix("/") || name.contains("\\") { return nil }
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) { return nil }
        let parts = name.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for p in parts {
            if p.isEmpty || p == "." || p == ".." || p.hasPrefix(".") { return nil }
        }
        return parts
    }

    public static func isSafe(_ name: String) -> Bool { components(name) != nil }
}
