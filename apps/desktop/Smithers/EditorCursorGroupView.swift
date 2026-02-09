import AppKit

final class EditorCursorGroupView: NSView {
    var cursorColor: NSColor = .white {
        didSet { updateColors() }
    }
    var outlineColor: NSColor = .white {
        didSet { updateColors() }
    }
    var showsOutlineWhenInactive: Bool = true {
        didSet { updateColors() }
    }
    var isActive: Bool = true {
        didSet { updateActiveState() }
    }
    var blinkEnabled: Bool = true {
        didSet { updateBlinking() }
    }

    private var cursorViews: [EditorCursorView] = []
    private var lastRects: [NSRect] = []

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func setVisible(_ visible: Bool) {
        cursorViews.forEach { $0.setVisible(visible) }
    }

    func update(rects: [NSRect], lineHeight: CGFloat, restartBlink: Bool) {
        guard !rects.isEmpty else {
            setVisible(false)
            lastRects = []
            return
        }

        ensureCursorCount(rects.count)

        for idx in 0..<rects.count {
            let cursor = cursorViews[idx]
            cursor.cursorColor = cursorColor
            cursor.outlineColor = outlineColor
            cursor.showsOutlineWhenInactive = showsOutlineWhenInactive
            cursor.isActive = isActive
            cursor.blinkEnabled = blinkEnabled
            let motion = motionKind(from: idx < lastRects.count ? lastRects[idx] : nil, to: rects[idx], lineHeight: lineHeight)
            cursor.move(to: rects[idx], motion: motion, restartBlink: restartBlink)
            cursor.setVisible(true)
        }

        if rects.count < cursorViews.count {
            for idx in rects.count..<cursorViews.count {
                cursorViews[idx].setVisible(false)
            }
        }

        lastRects = rects
    }

    private func ensureCursorCount(_ count: Int) {
        guard cursorViews.count < count else { return }
        for _ in cursorViews.count..<count {
            let cursor = EditorCursorView()
            cursor.cursorColor = cursorColor
            cursor.outlineColor = outlineColor
            cursor.showsOutlineWhenInactive = showsOutlineWhenInactive
            cursor.isActive = isActive
            cursor.blinkEnabled = blinkEnabled
            cursor.setVisible(false)
            addSubview(cursor)
            cursorViews.append(cursor)
        }
    }

    private func updateColors() {
        cursorViews.forEach { cursor in
            cursor.cursorColor = cursorColor
            cursor.outlineColor = outlineColor
            cursor.showsOutlineWhenInactive = showsOutlineWhenInactive
        }
    }

    private func updateActiveState() {
        cursorViews.forEach { $0.isActive = isActive }
    }

    private func updateBlinking() {
        cursorViews.forEach { $0.blinkEnabled = blinkEnabled }
    }

    private func motionKind(from previous: NSRect?, to next: NSRect, lineHeight: CGFloat) -> EditorCursorView.MotionKind {
        guard let previous else { return .short }
        let dx = next.minX - previous.minX
        let dy = next.minY - previous.minY
        let distance = hypot(dx, dy)
        let threshold = max(lineHeight * 2.5, 24)
        return distance > threshold ? .long : .short
    }
}
