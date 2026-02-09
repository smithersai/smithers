import AppKit

struct ScrollbarMetrics: Equatable {
    var contentLength: CGFloat
    var viewportLength: CGFloat
    var offset: CGFloat
}

final class ScrollbarOverlayView: NSView {
    var showMode: ScrollbarVisibilityMode = .automatic {
        didSet {
            updateVisibility(animated: false)
        }
    }
    var theme: AppTheme = .default {
        didSet {
            needsDisplay = true
        }
    }
    var metrics: ScrollbarMetrics? {
        didSet {
            if metrics != oldValue {
                needsDisplay = true
                updateVisibility(animated: false)
            }
        }
    }

    var onScrollToOffset: ((CGFloat) -> Void)?
    var onPageScroll: ((Int) -> Void)?

    private let trackInsets = NSEdgeInsets(top: 4, left: 2, bottom: 4, right: 2)
    private let minKnobHeight: CGFloat = 24
    private let knobCornerRadius: CGFloat = 4
    private let baseKnobAlpha: CGFloat = 0.38
    private let hoverKnobAlpha: CGFloat = 0.55
    private let showDuration: TimeInterval = 0.12
    private let hideDuration: TimeInterval = 0.22
    private let hideDelay: TimeInterval = 1.1

    private var isDragging = false
    private var isHovering = false
    private var dragOffset: CGFloat = 0
    private var transientVisible = false
    private var hideWorkItem: DispatchWorkItem?
    private var tracking: NSTrackingArea?

    var preferredWidth: CGFloat { 12 }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        alphaValue = 0
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func updateTrackingAreas() {
        if let tracking {
            removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow, .inVisibleRect]
        let area = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let knob = knobRect() else { return }

        let baseColor = theme.isLight ? NSColor.black : NSColor.white
        let alpha = (isHovering || isDragging) ? hoverKnobAlpha : baseKnobAlpha
        let knobColor = baseColor.withAlphaComponent(alpha)

        let path = NSBezierPath(roundedRect: knob, xRadius: knobCornerRadius, yRadius: knobCornerRadius)
        knobColor.setFill()
        path.fill()
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
        if showMode == .automatic {
            transientVisible = true
            updateVisibility(animated: true)
        }
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let hovering = trackRect().contains(point)
        if hovering != isHovering {
            isHovering = hovering
            if showMode == .automatic {
                transientVisible = hovering
                updateVisibility(animated: true)
            }
        }
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
        if showMode == .automatic {
            transientVisible = false
            scheduleHide()
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard isScrollable else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard let knob = knobRect() else { return }

        if knob.contains(point) {
            isDragging = true
            dragOffset = point.y - knob.minY
            transientVisible = true
            updateVisibility(animated: true)
            return
        }

        if point.y < knob.minY {
            onPageScroll?(-1)
            notifyScrollActivity()
        } else if point.y > knob.maxY {
            onPageScroll?(1)
            notifyScrollActivity()
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard isDragging, let metrics else { return }
        let point = convert(event.locationInWindow, from: nil)
        let track = trackRect()
        let knobHeight = knobHeight(for: metrics, trackHeight: track.height)
        let travel = max(track.height - knobHeight, 1)
        let origin = min(max(point.y - dragOffset, track.minY), track.maxY - knobHeight)
        let fraction = (origin - track.minY) / travel
        let maxOffset = max(metrics.contentLength - metrics.viewportLength, 0)
        let targetOffset = maxOffset * fraction
        onScrollToOffset?(targetOffset)
    }

    override func mouseUp(with event: NSEvent) {
        guard isDragging else { return }
        isDragging = false
        scheduleHide()
    }

    func updateMetrics(_ metrics: ScrollbarMetrics?) {
        self.metrics = metrics
    }

    func notifyScrollActivity() {
        guard showMode != .always else { return }
        transientVisible = true
        updateVisibility(animated: true)
        scheduleHide()
    }

    private var isScrollable: Bool {
        guard let metrics else { return false }
        return metrics.contentLength > metrics.viewportLength + 1
    }

    private func trackRect() -> NSRect {
        return NSRect(
            x: bounds.minX + trackInsets.left,
            y: bounds.minY + trackInsets.top,
            width: max(0, bounds.width - trackInsets.left - trackInsets.right),
            height: max(0, bounds.height - trackInsets.top - trackInsets.bottom)
        )
    }

    private func knobHeight(for metrics: ScrollbarMetrics, trackHeight: CGFloat) -> CGFloat {
        if metrics.contentLength <= 0 { return trackHeight }
        let ratio = metrics.viewportLength / metrics.contentLength
        let height = trackHeight * min(max(ratio, 0), 1)
        return max(minKnobHeight, min(trackHeight, height))
    }

    private func knobRect() -> NSRect? {
        guard let metrics, isScrollable else { return nil }
        let track = trackRect()
        guard track.height > 0 else { return nil }
        let knobHeight = knobHeight(for: metrics, trackHeight: track.height)
        let travel = max(track.height - knobHeight, 1)
        let maxOffset = max(metrics.contentLength - metrics.viewportLength, 0)
        let fraction = maxOffset > 0 ? min(max(metrics.offset / maxOffset, 0), 1) : 0
        let y = track.minY + (travel * fraction)
        return NSRect(x: track.minX, y: y, width: track.width, height: knobHeight)
    }

    private func updateVisibility(animated: Bool) {
        let shouldShow: Bool
        switch showMode {
        case .always:
            shouldShow = isScrollable
        case .whenScrolling:
            shouldShow = isScrollable && (transientVisible || isDragging)
        case .automatic:
            shouldShow = isScrollable && (transientVisible || isHovering || isDragging)
        }

        let targetAlpha: CGFloat = shouldShow ? 1 : 0
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = shouldShow ? showDuration : hideDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                animator().alphaValue = targetAlpha
            }
        } else {
            alphaValue = targetAlpha
        }
    }

    private func scheduleHide() {
        hideWorkItem?.cancel()
        guard showMode != .always else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if self.isDragging || self.isHovering {
                return
            }
            self.transientVisible = false
            self.updateVisibility(animated: true)
        }
        hideWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + hideDelay, execute: workItem)
    }
}
