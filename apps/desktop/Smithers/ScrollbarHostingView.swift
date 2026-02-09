import AppKit

final class ScrollbarHostingView: NSView {
    let contentView: NSView
    let scrollbarView: ScrollbarOverlayView

    init(contentView: NSView, scrollbarView: ScrollbarOverlayView) {
        self.contentView = contentView
        self.scrollbarView = scrollbarView
        super.init(frame: .zero)
        addSubview(contentView)
        addSubview(scrollbarView)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func layout() {
        super.layout()
        contentView.frame = bounds
        let width = scrollbarView.preferredWidth
        scrollbarView.frame = NSRect(
            x: max(0, bounds.width - width),
            y: 0,
            width: width,
            height: bounds.height
        )
    }
}
