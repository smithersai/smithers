import AppKit

@MainActor
enum WindowFrameStore {
    private static let frameMapKey = "smithers.windowFramesByRoot"
    private static let legacyFrameKey = "smithers.windowFrame"
    private static let emptyWorkspaceKey = "__smithers_no_workspace__"

    static func saveFrame(_ frame: NSRect, for rootDirectory: URL?) {
        guard isValidFrame(frame) else { return }
        var map = loadFrameMap()
        map[key(for: rootDirectory)] = NSStringFromRect(frame)
        saveFrameMap(map)
    }

    static func loadFrame(for rootDirectory: URL?) -> NSRect? {
        let map = loadFrameMap()
        let workspaceKey = key(for: rootDirectory)
        if let raw = map[workspaceKey], let frame = parseFrame(raw) {
            return frame
        }
        let hasOnlyEmpty = map.count == 1 && map[emptyWorkspaceKey] != nil
        if (map.isEmpty || hasOnlyEmpty),
           let raw = UserDefaults.standard.string(forKey: legacyFrameKey),
           let frame = parseFrame(raw) {
            var migrated = map
            migrated[workspaceKey] = NSStringFromRect(frame)
            saveFrameMap(migrated)
            return frame
        }
        return nil
    }

    static func adjustedFrame(_ frame: NSRect) -> NSRect {
        guard !frame.isNull, !frame.isInfinite else { return frame }
        for screen in NSScreen.screens {
            let visible = screen.visibleFrame
            if visible.intersects(frame) {
                return clampFrame(frame, to: visible)
            }
        }
        guard let screen = NSScreen.main else { return frame }
        let visible = screen.visibleFrame
        let width = min(frame.width, visible.width)
        let height = min(frame.height, visible.height)
        let x = visible.origin.x + (visible.width - width) / 2
        let y = visible.origin.y + (visible.height - height) / 2
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private static func clampFrame(_ frame: NSRect, to bounds: NSRect) -> NSRect {
        var clamped = frame
        if clamped.width > bounds.width {
            clamped.size.width = bounds.width
        }
        if clamped.height > bounds.height {
            clamped.size.height = bounds.height
        }
        if clamped.minX < bounds.minX {
            clamped.origin.x = bounds.minX
        }
        if clamped.maxX > bounds.maxX {
            clamped.origin.x = bounds.maxX - clamped.width
        }
        if clamped.minY < bounds.minY {
            clamped.origin.y = bounds.minY
        }
        if clamped.maxY > bounds.maxY {
            clamped.origin.y = bounds.maxY - clamped.height
        }
        return clamped
    }

    private static func key(for rootDirectory: URL?) -> String {
        guard let rootDirectory else { return emptyWorkspaceKey }
        return rootDirectory.standardizedFileURL.path
    }

    private static func parseFrame(_ raw: String) -> NSRect? {
        let frame = NSRectFromString(raw)
        return isValidFrame(frame) ? frame : nil
    }

    private static func isValidFrame(_ frame: NSRect) -> Bool {
        frame.width > 0 && frame.height > 0
    }

    private static func loadFrameMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: frameMapKey) as? [String: String] ?? [:]
    }

    private static func saveFrameMap(_ map: [String: String]) {
        UserDefaults.standard.set(map, forKey: frameMapKey)
    }
}
