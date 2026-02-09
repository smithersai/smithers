import SwiftUI

struct TerminalTabView: NSViewRepresentable {
    let view: GhosttyTerminalView
    var scrollbarMode: ScrollbarVisibilityMode = .automatic
    var scrollbarMetrics: ScrollbarMetrics?
    var theme: AppTheme = .default
    var onScrollToOffset: ((CGFloat) -> Void)?
    var onPageScroll: ((Int) -> Void)?
    var floatingWindowEffects: NvimFloatingWindowEffects?

    func makeNSView(context: Context) -> ScrollbarHostingView {
        let scrollbarView = ScrollbarOverlayView()
        scrollbarView.showMode = scrollbarMode
        scrollbarView.theme = theme
        scrollbarView.updateMetrics(scrollbarMetrics)
        scrollbarView.onScrollToOffset = onScrollToOffset
        scrollbarView.onPageScroll = onPageScroll
        view.onScrollActivity = { [weak scrollbarView] in
            scrollbarView?.notifyScrollActivity()
        }
        let overlayView = makeFloatingOverlayView()
        view.smoothScrollOverlayView = overlayView
        return ScrollbarHostingView(contentView: view, scrollbarView: scrollbarView, overlayView: overlayView)
    }

    func updateNSView(_ containerView: ScrollbarHostingView, context: Context) {
        let scrollbarView = containerView.scrollbarView
        let previousMetrics = scrollbarView.metrics
        scrollbarView.showMode = scrollbarMode
        scrollbarView.theme = theme
        scrollbarView.updateMetrics(scrollbarMetrics)
        scrollbarView.onScrollToOffset = onScrollToOffset
        scrollbarView.onPageScroll = onPageScroll
        if scrollbarMetrics != nil, scrollbarMetrics != previousMetrics {
            scrollbarView.notifyScrollActivity()
        }
        view.onScrollActivity = { [weak scrollbarView] in
            scrollbarView?.notifyScrollActivity()
        }
        view.smoothScrollOverlayView = containerView.overlayView

        if let overlayView = containerView.overlayView as? NvimFloatingWindowOverlayView {
            if let effects = floatingWindowEffects {
                overlayView.effects = effects
                overlayView.isHidden = effects.windows.isEmpty || !effects.isActive
            } else {
                overlayView.effects = .empty
                overlayView.isHidden = true
            }
        }
    }

    private func makeFloatingOverlayView() -> NvimFloatingWindowOverlayView {
        let overlayView = NvimFloatingWindowOverlayView()
        overlayView.terminalView = view
        let effects = floatingWindowEffects ?? .empty
        overlayView.effects = effects
        overlayView.isHidden = effects.windows.isEmpty || !effects.isActive
        return overlayView
    }
}

struct TerminalTabBarItem: View {
    @ObservedObject var view: GhosttyTerminalView
    let isSelected: Bool
    let theme: AppTheme
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        let title = view.title.isEmpty ? "Terminal" : view.title
        let subtitle = view.pwd ?? "Terminal"
        TabBarItem(
            title: title,
            subtitle: subtitle,
            icon: "terminal",
            isSelected: isSelected,
            isModified: false,
            isDropTarget: false,
            theme: theme,
            onSelect: onSelect,
            onClose: onClose
        )
    }
}
