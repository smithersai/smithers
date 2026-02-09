import AppKit
import CoreImage
import QuartzCore

struct NvimFloatingWindow: Identifiable, Equatable {
    let id: Int64
    var row: Double
    var col: Double
    var width: Int
    var height: Int
    var zIndex: Int
}

struct NvimFloatingWindowEffects: Equatable {
    var windows: [NvimFloatingWindow]
    var blurEnabled: Bool
    var blurRadius: CGFloat
    var cornerRadius: CGFloat
    var shadowEnabled: Bool
    var shadowRadius: CGFloat
    var shadowOpacity: Float
    var shadowOffset: CGSize

    var isActive: Bool {
        (blurEnabled && blurRadius > 0) || cornerRadius > 0 || (shadowEnabled && shadowRadius > 0)
    }

    static let empty = NvimFloatingWindowEffects(
        windows: [],
        blurEnabled: false,
        blurRadius: 0,
        cornerRadius: 0,
        shadowEnabled: false,
        shadowRadius: 0,
        shadowOpacity: 0,
        shadowOffset: .zero
    )
}

final class NvimFloatingWindowOverlayView: NSView {
    weak var terminalView: GhosttyTerminalView? {
        didSet {
            attachGridMetricsObserver(oldValue: oldValue)
            needsLayout = true
        }
    }

    var effects: NvimFloatingWindowEffects = .empty {
        didSet {
            updateEffects(previous: oldValue)
        }
    }

    private var effectViews: [Int64: FloatingWindowEffectView] = [:]
    private var gridMetricsObserver: UUID?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) {
        return nil
    }

    deinit {
        detachGridMetricsObserver()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }

    override func layout() {
        super.layout()
        updateFrames()
    }

    private func updateEffects(previous: NvimFloatingWindowEffects) {
        if effects.windows != previous.windows {
            syncWindowViews()
        }
        if effects != previous {
            applyStyle()
        }
        isHidden = effects.windows.isEmpty || !effects.isActive
        needsLayout = true
    }

    private func syncWindowViews() {
        let activeIds = Set(effects.windows.map { $0.id })
        for (id, view) in effectViews where !activeIds.contains(id) {
            view.removeFromSuperview()
            effectViews.removeValue(forKey: id)
        }

        for window in effects.windows where effectViews[window.id] == nil {
            let view = FloatingWindowEffectView()
            effectViews[window.id] = view
            addSubview(view)
        }
        applyStyle()
    }

    private func applyStyle() {
        for view in effectViews.values {
            view.style = effects
        }
    }

    private func updateFrames() {
        guard let metrics = terminalView?.gridMetrics() else {
            effectViews.values.forEach { $0.isHidden = true }
            return
        }

        let ordered = effects.windows.sorted {
            if $0.zIndex == $1.zIndex { return $0.id < $1.id }
            return $0.zIndex < $1.zIndex
        }

        let cellSize = metrics.cellSize
        let origin = metrics.origin
        let totalRows = CGFloat(metrics.rows)

        for (index, window) in ordered.enumerated() {
            guard let view = effectViews[window.id] else { continue }
            let width = CGFloat(window.width) * cellSize.width
            let height = CGFloat(window.height) * cellSize.height
            let x = origin.x + CGFloat(window.col) * cellSize.width
            let y = origin.y + (totalRows - CGFloat(window.row) - CGFloat(window.height)) * cellSize.height
            view.frame = NSRect(x: x, y: y, width: width, height: height)
            view.layer?.zPosition = CGFloat(window.zIndex) + CGFloat(index) * 0.001
            view.isHidden = !effects.isActive
        }
    }

    private func attachGridMetricsObserver(oldValue: GhosttyTerminalView?) {
        if let oldValue, let token = gridMetricsObserver {
            oldValue.removeGridMetricsObserver(token)
        }
        gridMetricsObserver = nil
        guard let terminalView else { return }
        gridMetricsObserver = terminalView.addGridMetricsObserver { [weak self] _ in
            DispatchQueue.main.async {
                self?.needsLayout = true
            }
        }
    }

    private func detachGridMetricsObserver() {
        guard let terminalView, let token = gridMetricsObserver else { return }
        terminalView.removeGridMetricsObserver(token)
        gridMetricsObserver = nil
    }
}

private final class FloatingWindowEffectView: NSView {
    var style: NvimFloatingWindowEffects = .empty {
        didSet {
            applyStyle()
        }
    }

    private let blurView = FloatingWindowBlurView()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = false
        addSubview(blurView)
        applyStyle()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func layout() {
        super.layout()
        blurView.frame = bounds
        updateShadowPath()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }

    private func applyStyle() {
        blurView.blurRadius = style.blurEnabled ? style.blurRadius : 0
        blurView.cornerRadius = style.cornerRadius

        if style.shadowEnabled && style.shadowRadius > 0 {
            layer?.shadowOpacity = style.shadowOpacity
            layer?.shadowRadius = style.shadowRadius
            layer?.shadowOffset = style.shadowOffset
            layer?.shadowColor = NSColor.black.cgColor
        } else {
            layer?.shadowOpacity = 0
            layer?.shadowRadius = 0
            layer?.shadowOffset = .zero
        }
        updateShadowPath()
    }

    private func updateShadowPath() {
        guard let layer else { return }
        let radius = max(style.cornerRadius, 0)
        if radius > 0 {
            layer.shadowPath = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
        } else {
            layer.shadowPath = CGPath(rect: bounds, transform: nil)
        }
    }
}

private final class FloatingWindowBlurView: NSView {
    var blurRadius: CGFloat = 0 {
        didSet {
            updateBlurFilter()
        }
    }

    var cornerRadius: CGFloat = 0 {
        didSet {
            updateCornerRadius()
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = true
        updateBlurFilter()
        updateCornerRadius()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    private func updateBlurFilter() {
        guard let layer else { return }
        guard blurRadius > 0 else {
            layer.backgroundFilters = nil
            return
        }
        let filter = CIFilter(name: "CIGaussianBlur")
        filter?.setValue(blurRadius, forKey: kCIInputRadiusKey)
        if let filter {
            layer.backgroundFilters = [filter]
        } else {
            layer.backgroundFilters = nil
        }
    }

    private func updateCornerRadius() {
        guard let layer else { return }
        layer.cornerRadius = max(cornerRadius, 0)
        if #available(macOS 13.0, *) {
            layer.cornerCurve = .continuous
        }
    }
}
