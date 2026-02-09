import AppKit

final class GhostTextOverlayView: NSView {
    var ghostText: String = "" {
        didSet { needsDisplay = true }
    }
    var caretRect: NSRect? {
        didSet { needsDisplay = true }
    }
    var lineStartX: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    var font: NSFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) {
        didSet { needsDisplay = true }
    }
    var lineSpacing: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    var characterSpacing: CGFloat = 0 {
        didSet { needsDisplay = true }
    }
    var textColor: NSColor = .secondaryLabelColor {
        didSet { needsDisplay = true }
    }

    override var isOpaque: Bool { false }

    override var isFlipped: Bool {
        superview?.isFlipped ?? true
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        alphaValue = 0
        isHidden = true
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func setVisible(_ visible: Bool, animated: Bool = true) {
        guard visible != !isHidden else { return }
        if visible {
            isHidden = false
        }
        let targetAlpha: CGFloat = visible ? 1 : 0
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                animator().alphaValue = targetAlpha
            } completionHandler: {
                if !visible {
                    self.isHidden = true
                }
            }
        } else {
            alphaValue = targetAlpha
            if !visible {
                isHidden = true
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !ghostText.isEmpty, let caretRect else { return }
        let availableWidth = max(bounds.width - lineStartX, 1)
        let indent = max(0, caretRect.minX - lineStartX)

        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing
        style.lineBreakMode = .byCharWrapping
        style.firstLineHeadIndent = indent
        style.headIndent = 0

        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor,
            .paragraphStyle: style,
            .kern: characterSpacing,
        ]

        let storage = NSTextStorage(string: ghostText, attributes: attrs)
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: availableWidth, height: bounds.height))
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: container)

        let glyphRange = layoutManager.glyphRange(for: container)
        let origin = CGPoint(x: lineStartX, y: caretRect.minY)
        layoutManager.drawGlyphs(forGlyphRange: glyphRange, at: origin)
    }
}
