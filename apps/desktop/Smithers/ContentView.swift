import SwiftUI
import AppKit
import Foundation
import Dispatch
import STTextView
import QuartzCore

struct EditorViewState: Equatable {
    var scrollOrigin: CGPoint
    var selectionRange: NSRange
}

struct EditorScrollMetrics: Equatable {
    var contentHeight: CGFloat = 1
    var viewportHeight: CGFloat = 1
    var scrollY: CGFloat = 0
}

struct CodeEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var selectionRequest: EditorSelection?
    @Binding var scrollMetrics: EditorScrollMetrics
    @Binding var fontSize: Double
    var language: SupportedLanguage?
    var fileURL: URL?
    var theme: AppTheme
    var font: NSFont
    var lineSpacing: Double
    var characterSpacing: Double
    var ligaturesEnabled: Bool
    var cursorStyle: EditorCursorShape = .bar
    var scrollbarMode: ScrollbarVisibilityMode
    var showsLineNumbers: Bool
    var highlightsCurrentLine: Bool
    var showsIndentGuides: Bool
    var minFontSize: Double
    var maxFontSize: Double
    var saveViewState: (URL, CGPoint, NSRange) -> Void
    var loadViewState: (URL) -> EditorViewState?
    var onCursorMove: (Int, Int) -> Void
    var onTextEdit: ((Int, Int) -> Void)?
    var completionProvider: ((EditorCompletionRequest, @escaping @MainActor (String) -> Void) async -> String?)?
    var cancelCompletionRequest: (() -> Void)?

    func makeNSView(context: Context) -> ScrollbarHostingView {
        let scrollView = MultiCursorTextView.scrollableTextView()
        let textView = scrollView.documentView as! STTextView

        textView.font = font
        textView.backgroundColor = theme.background
        textView.insertionPointColor = .clear
        textView.highlightSelectedLine = highlightsCurrentLine
        textView.selectedLineHighlightColor = theme.lineHighlight
        textView.widthTracksTextView = true
        textView.textColor = theme.foreground
        textView.delegate = context.coordinator
        let rulerView = STLineNumberRulerView(textView: textView)
        rulerView.font = Self.lineNumberFont(for: font)
        rulerView.invalidateHashMarks()
        rulerView.backgroundColor = theme.lineNumberBackground
        rulerView.textColor = theme.lineNumberForeground
        rulerView.highlightSelectedLine = highlightsCurrentLine
        rulerView.selectedLineTextColor = theme.lineNumberSelectedForeground
        rulerView.drawSeparator = false
        rulerView.rulerInsets = STRulerInsets(leading: 8, trailing: 8)
        scrollView.verticalRulerView = rulerView
        scrollView.rulersVisible = showsLineNumbers

        scrollView.backgroundColor = theme.background
        scrollView.scrollerStyle = .overlay
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.contentView.postsBoundsChangedNotifications = true
        scrollView.setAccessibilityIdentifier("CodeEditor")
        textView.setAccessibilityIdentifier("CodeEditorTextView")

        let scrollbarView = ScrollbarOverlayView()
        scrollbarView.showMode = scrollbarMode
        scrollbarView.theme = theme

        context.coordinator.attach(scrollView: scrollView, textView: textView, scrollbar: scrollbarView)
        updateIndentGuides(
            textView: textView,
            theme: theme,
            font: font,
            characterSpacing: characterSpacing,
            isEnabled: showsIndentGuides,
            coordinator: context.coordinator
        )
        context.coordinator.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
        context.coordinator.appliedTheme = theme
        context.coordinator.appliedFont = font
        context.coordinator.appliedSignature = textLayoutSignature

        return ScrollbarHostingView(contentView: scrollView, scrollbarView: scrollbarView)
    }

    func updateNSView(_ containerView: ScrollbarHostingView, context: Context) {
        guard let scrollView = containerView.contentView as? NSScrollView,
              let textView = scrollView.documentView as? STTextView else { return }
        let coord = context.coordinator
        coord.parent = self
        let scrollbarView = containerView.scrollbarView
        scrollbarView.showMode = scrollbarMode
        scrollbarView.theme = theme
        coord.attach(scrollView: scrollView, textView: textView, scrollbar: scrollbarView)
        if scrollView.rulersVisible != showsLineNumbers {
            scrollView.rulersVisible = showsLineNumbers
        }
        if textView.highlightSelectedLine != highlightsCurrentLine {
            textView.highlightSelectedLine = highlightsCurrentLine
        }
        if let rulerView = scrollView.verticalRulerView as? STLineNumberRulerView {
            rulerView.highlightSelectedLine = highlightsCurrentLine
        }

        if coord.appliedTheme != theme {
            let previousTheme = coord.appliedTheme
            applyTheme(theme, previousTheme: previousTheme, to: textView, scrollView: scrollView)
            coord.appliedTheme = theme
        }
        updateIndentGuides(
            textView: textView,
            theme: theme,
            font: font,
            characterSpacing: characterSpacing,
            isEnabled: showsIndentGuides,
            coordinator: coord
        )
        coord.refreshCursorAppearance(textView: textView)
        coord.updateGhostView(textView: textView)

        if coord.currentFileURL != fileURL {
            coord.saveViewState(for: coord.currentFileURL, textView: textView, scrollView: scrollView)
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            coord.restoreViewState(for: fileURL, textView: textView, scrollView: scrollView)
            coord.updateScrollMetrics(textView: textView, scrollView: scrollView)
            applySelectionRequest(textView: textView, scrollView: scrollView)
            coord.refreshCursorPosition(textView: textView, restartBlink: false)
            return
        }

        let signature = textLayoutSignature
        if coord.appliedSignature != signature {
            coord.saveViewState(for: coord.currentFileURL, textView: textView, scrollView: scrollView)
            coord.appliedFont = font
            coord.appliedSignature = signature
            coord.resetHighlighterCache()
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            coord.restoreViewState(for: fileURL, textView: textView, scrollView: scrollView)
            updateLineNumberFont(font, scrollView: scrollView)
            updateIndentGuides(
                textView: textView,
                theme: theme,
                font: font,
                characterSpacing: characterSpacing,
                isEnabled: showsIndentGuides,
                coordinator: coord
            )
            coord.updateScrollMetrics(textView: textView, scrollView: scrollView)
            coord.refreshCursorAppearance(textView: textView)
            coord.refreshCursorPosition(textView: textView, restartBlink: false)
            return
        }

        if coord.lastAppliedText != text {
            coord.ignoreNextChange = true
            coord.setTextViewContent(textView, text: text)
            coord.scheduleHighlight(textView: textView, text: text, delay: 0)
        }

        applySelectionRequest(textView: textView, scrollView: scrollView)
        coord.refreshCursorPosition(textView: textView, restartBlink: false)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    private var textLayoutSignature: String {
        Self.layoutSignature(
            font: font,
            lineSpacing: lineSpacing,
            characterSpacing: characterSpacing,
            ligaturesEnabled: ligaturesEnabled
        )
    }

    private func baseParagraphStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = CGFloat(lineSpacing)
        return style
    }

    private func baseTextAttributes() -> [NSAttributedString.Key: Any] {
        [
            .foregroundColor: theme.foreground,
            .font: font,
            .paragraphStyle: baseParagraphStyle(),
            .kern: CGFloat(characterSpacing),
            .ligature: ligaturesEnabled ? 1 : 0,
        ]
    }

    private static func layoutSignature(
        font: NSFont,
        lineSpacing: Double,
        characterSpacing: Double,
        ligaturesEnabled: Bool
    ) -> String {
        let size = String(format: "%.2f", font.pointSize)
        let line = String(format: "%.2f", lineSpacing)
        let tracking = String(format: "%.2f", characterSpacing)
        let ligatures = ligaturesEnabled ? "1" : "0"
        return "\(font.fontName)-\(size)-ls\(line)-cs\(tracking)-lig\(ligatures)"
    }

    private func applySelectionRequest(textView: STTextView, scrollView: NSScrollView) {
        guard let selection = selectionRequest else { return }
        guard selection.url.standardizedFileURL == fileURL?.standardizedFileURL else { return }
        let currentText = textView.attributedString().string
        if selection.line > 1 {
            let lineCount = currentText.reduce(1) { count, ch in
                ch == "\n" ? count + 1 : count
            }
            if lineCount < selection.line {
                return
            }
        }
        if let range = rangeForLineColumn(
            text: currentText,
            line: selection.line,
            column: selection.column,
            length: selection.length
        ) {
            textView.setSelectedRange(range)
            animateScrollToRange(range, textView: textView, scrollView: scrollView)
        }
        DispatchQueue.main.async {
            selectionRequest = nil
        }
    }

    private func rangeForLineColumn(text: String, line: Int, column: Int, length: Int) -> NSRange? {
        guard line > 0 else { return nil }
        let nsText = text as NSString
        var currentLine = 1
        var index = 0
        while currentLine < line && index < nsText.length {
            let range = nsText.lineRange(for: NSRange(location: index, length: 0))
            index = NSMaxRange(range)
            currentLine += 1
        }
        if index > nsText.length {
            return NSRange(location: nsText.length, length: 0)
        }
        let lineRange = nsText.lineRange(for: NSRange(location: index, length: 0))
        let columnOffset = max(0, column - 1)
        let lineEnd = max(lineRange.location, NSMaxRange(lineRange) - 1)
        let target = min(index + columnOffset, lineEnd)
        let requestedLength = max(0, length)
        let maxLength = max(0, lineEnd - target)
        return NSRange(location: target, length: min(requestedLength, maxLength))
    }

    private func animateScrollToRange(_ range: NSRange, textView: STTextView, scrollView: NSScrollView) {
        guard let textRange = NSTextRange(range, in: textView.textContentManager),
              let targetRect = textView.textLayoutManager.textSegmentFrame(
                  in: textRange,
                  type: .standard,
                  options: .rangeNotRequired
              ) ?? textView.textLayoutManager.textSegmentFrame(
                  at: textRange.location,
                  type: .standard
              ) else {
            textView.scrollRangeToVisible(range)
            return
        }
        let targetY = max(0, targetRect.midY - scrollView.contentView.bounds.height / 2)
        let targetPoint = CGPoint(x: 0, y: targetY)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            scrollView.contentView.animator().setBoundsOrigin(targetPoint)
        }
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func applyTheme(_ theme: AppTheme, previousTheme: AppTheme?, to textView: STTextView, scrollView: NSScrollView) {
        textView.backgroundColor = theme.background
        textView.insertionPointColor = .clear
        textView.selectedLineHighlightColor = theme.lineHighlight
        textView.textColor = theme.foreground
        var typing = textView.typingAttributes
        typing[.foregroundColor] = theme.foreground
        textView.typingAttributes = typing
        if let rulerView = scrollView.verticalRulerView as? STLineNumberRulerView {
            rulerView.backgroundColor = theme.lineNumberBackground
            rulerView.textColor = theme.lineNumberForeground
            rulerView.selectedLineTextColor = theme.lineNumberSelectedForeground
        }
        scrollView.backgroundColor = theme.background

        guard let previousTheme,
              !previousTheme.foreground.isApproximatelyEqual(to: theme.foreground) else { return }
        updateExistingTextColor(from: previousTheme.foreground, to: theme.foreground, textView: textView)
    }

    private func updateLineNumberFont(_ font: NSFont, scrollView: NSScrollView) {
        guard let rulerView = scrollView.verticalRulerView as? STLineNumberRulerView else { return }
        rulerView.font = Self.lineNumberFont(for: font)
        rulerView.invalidateHashMarks()
    }

    private static func lineNumberFont(for font: NSFont) -> NSFont {
        let features: [[NSFontDescriptor.FeatureKey: Int]] = [
            [
                .typeIdentifier: kTextSpacingType,
                .selectorIdentifier: kMonospacedTextSelector,
            ],
            [
                .typeIdentifier: kNumberSpacingType,
                .selectorIdentifier: kMonospacedNumbersSelector,
            ],
            [
                .typeIdentifier: kNumberCaseType,
                .selectorIdentifier: kUpperCaseNumbersSelector,
            ],
            [
                .typeIdentifier: kStylisticAlternativesType,
                .selectorIdentifier: kStylisticAltOneOnSelector,
            ],
            [
                .typeIdentifier: kStylisticAlternativesType,
                .selectorIdentifier: kStylisticAltTwoOnSelector,
            ],
            [
                .typeIdentifier: kTypographicExtrasType,
                .selectorIdentifier: kSlashedZeroOnSelector,
            ],
        ]
        let descriptor = font.fontDescriptor.addingAttributes([.featureSettings: features])
        return NSFont(descriptor: descriptor, size: font.pointSize) ?? font
    }

    private static func cursorWidth(for font: NSFont) -> CGFloat {
        max(2, round(font.pointSize * 0.12))
    }

    private static func indentGuideWidth(for font: NSFont, characterSpacing: Double) -> CGFloat {
        let spaceWidth = (" " as NSString).size(withAttributes: [.font: font]).width
        let kern = CGFloat(characterSpacing)
        let width = (spaceWidth * 4) + (kern * 3)
        return max(12, round(width))
    }

    private func updateIndentGuides(
        textView: STTextView,
        theme: AppTheme,
        font: NSFont,
        characterSpacing: Double,
        isEnabled: Bool,
        coordinator: Coordinator
    ) {
        guard isEnabled else {
            if let guidesView = coordinator.indentGuidesView {
                guidesView.removeFromSuperview()
                coordinator.indentGuidesView = nil
            }
            return
        }
        let indentWidth = Self.indentGuideWidth(for: font, characterSpacing: characterSpacing)
        let lineColor = theme.foreground.withAlphaComponent(0.06)
        if let guidesView = coordinator.indentGuidesView {
            guidesView.indentWidth = indentWidth
            guidesView.lineColor = lineColor
            guidesView.needsDisplay = true
            return
        }

        let guidesView = IndentGuidesView()
        guidesView.indentWidth = indentWidth
        guidesView.lineColor = lineColor
        guidesView.frame = textView.bounds
        guidesView.autoresizingMask = [.width, .height]
        textView.addSubview(guidesView, positioned: .below, relativeTo: nil)
        coordinator.indentGuidesView = guidesView
    }

    private func updateExistingTextColor(from oldColor: NSColor, to newColor: NSColor, textView: STTextView) {
        guard let storage = (textView.textContentManager as? NSTextContentStorage)?.textStorage else { return }
        let fullRange = NSRange(location: 0, length: storage.length)
        guard fullRange.length > 0 else { return }

        storage.beginEditing()
        storage.enumerateAttribute(.foregroundColor, in: fullRange, options: []) { value, range, _ in
            guard let color = value as? NSColor else { return }
            if color.isApproximatelyEqual(to: oldColor) {
                storage.addAttribute(.foregroundColor, value: newColor, range: range)
            }
        }
        storage.endEditing()
    }

    @MainActor private final class GlyphFrameCache {
        private let cache = NSCache<NSNumber, NSValue>()
        private var lastLayoutWidth: CGFloat = 0
        private var lastFontSignature: String = ""

        init() {
            cache.countLimit = 2_048
        }

        func invalidate() {
            cache.removeAllObjects()
        }

        func invalidateIfNeeded(textView: STTextView, signature: String) {
            let width = textView.bounds.width
            if abs(width - lastLayoutWidth) > 0.5 || signature != lastFontSignature {
                invalidate()
                lastLayoutWidth = width
                lastFontSignature = signature
            }
        }

        func frame(for location: Int, textView: STTextView) -> NSRect? {
            let key = NSNumber(value: location)
            if let cached = cache.object(forKey: key) {
                PerformanceMonitor.shared.recordGlyphCacheHit()
                return cached.rectValue
            }
            guard let textRange = NSTextRange(NSRange(location: location, length: 1), in: textView.textContentManager),
                  let rect = textView.textLayoutManager.textSegmentFrame(in: textRange, type: .standard)
            else {
                PerformanceMonitor.shared.recordGlyphCacheMiss()
                return nil
            }
            cache.setObject(NSValue(rect: rect), forKey: key)
            PerformanceMonitor.shared.recordGlyphCacheMiss()
            return rect
        }
    }

    @MainActor class Coordinator: NSObject, STTextViewDelegate {
        var parent: CodeEditor
        var ignoreNextChange = false
        var highlighter: TreeSitterHighlighter?
        var currentFileURL: URL?
        weak var scrollView: NSScrollView?
        weak var textView: STTextView?
        private weak var lineNumberView: STLineNumberRulerView?
        private weak var scrollbarView: ScrollbarOverlayView?
        fileprivate weak var indentGuidesView: IndentGuidesView?
        private weak var cursorView: EditorCursorGroupView?
        private var cursorObservers: [NSObjectProtocol] = []
        private weak var cursorWindow: NSWindow?
        private var scrollObserver: Any?
        private var magnificationRecognizer: NSMagnificationGestureRecognizer?
        private var highlighterCache: [String: TreeSitterHighlighter] = [:]
        private var highlightWorkItem: DispatchWorkItem?
        fileprivate var lastAppliedText: String = ""
        var appliedTheme: AppTheme?
        var appliedFont: NSFont?
        var appliedSignature: String?
        private var bracketHighlightRanges: [NSRange] = []
        private weak var ghostTextView: GhostTextOverlayView?
        private var ghostText: String = ""
        private var ghostAnchor: Int?
        private var completionWorkItem: DispatchWorkItem?
        private var completionTask: Task<Void, Never>?
        private var completionRequestID: Int = 0
        private var suppressNextCompletionRequest = false
        private var suppressSelectionCancel = false
        private var isApplyingCompletion = false
        private let completionDebounceInterval: TimeInterval = 0.3
        private var pinchStartFontSize: Double = 0
        private var pinchStartFont: NSFont?
        private var liveFontSize: Double?
        private var isPinching = false
        private let glyphFrameCache = GlyphFrameCache()
        private var isNormalizingSelections = false

        init(parent: CodeEditor) {
            self.parent = parent
        }

        deinit {
            if let scrollObserver {
                NotificationCenter.default.removeObserver(scrollObserver)
            }
            cursorObservers.forEach { NotificationCenter.default.removeObserver($0) }
            cursorObservers.removeAll()
            completionTask?.cancel()
            completionWorkItem?.cancel()
        }

        func attach(scrollView: NSScrollView, textView: STTextView, scrollbar: ScrollbarOverlayView) {
            if self.scrollView !== scrollView || self.textView !== textView {
                if let scrollObserver {
                    NotificationCenter.default.removeObserver(scrollObserver)
                    self.scrollObserver = nil
                }
                self.scrollView = scrollView
                self.textView = textView
                self.lineNumberView = scrollView.verticalRulerView as? STLineNumberRulerView
                if magnificationRecognizer == nil {
                    let recognizer = NSMagnificationGestureRecognizer(
                        target: self,
                        action: #selector(handleMagnification(_:))
                    )
                    scrollView.addGestureRecognizer(recognizer)
                    magnificationRecognizer = recognizer
                }
                scrollObserver = NotificationCenter.default.addObserver(
                    forName: NSView.boundsDidChangeNotification,
                    object: scrollView.contentView,
                    queue: .main
                ) { [weak self] _ in
                    guard let self, let textView = self.textView, let scrollView = self.scrollView else { return }
                    self.updateScrollMetrics(textView: textView, scrollView: scrollView)
                    self.saveViewState(for: self.currentFileURL, textView: textView, scrollView: scrollView)
                    self.scrollbarView?.notifyScrollActivity()
                }
            }

            scrollbarView = scrollbar
            configureScrollbarActions(scrollView: scrollView, scrollbar: scrollbar)
            if let textView = self.textView, let scrollView = self.scrollView {
                updateScrollMetrics(textView: textView, scrollView: scrollView)
                ensureGhostTextView(textView: textView)
                updateGhostView(textView: textView)
                ensureCursorView(textView: textView)
            }
        }

        func loadFile(text: String, language: SupportedLanguage?, fileURL: URL?, textView: STTextView) {
            currentFileURL = fileURL
            ignoreNextChange = true
            appliedFont = parent.font
            appliedSignature = parent.textLayoutSignature
            setTextViewContent(textView, text: text)
            resetCompletionState(textView: textView)

            if let language {
                if let cached = highlighterCache[language.name] {
                    highlighter = cached
                } else {
                    let h = TreeSitterHighlighter(
                        language: language,
                        font: parent.font,
                        lineSpacing: parent.lineSpacing,
                        characterSpacing: parent.characterSpacing,
                        ligaturesEnabled: parent.ligaturesEnabled
                    )
                    highlighterCache[language.name] = h
                    highlighter = h
                }
                scheduleHighlight(textView: textView, text: text, delay: 0)
            } else {
                highlighter = nil
            }
            refreshCursorAppearance(textView: textView)
            refreshCursorPosition(textView: textView, restartBlink: false)
        }

        func saveViewState(for url: URL?, textView: STTextView, scrollView: NSScrollView) {
            guard let url else { return }
            let scrollOrigin = scrollView.contentView.bounds.origin
            let selection = textView.selectedRange()
            parent.saveViewState(url, scrollOrigin, selection)
        }

        func restoreViewState(for url: URL?, textView: STTextView, scrollView: NSScrollView) {
            guard let url, let state = parent.loadViewState(url) else { return }
            textView.setSelectedRange(state.selectionRange)
            scrollView.contentView.scroll(to: state.scrollOrigin)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }

        func updateScrollMetrics(textView: STTextView, scrollView: NSScrollView) {
            let contentHeight = max(textView.bounds.height, 1)
            let viewportHeight = max(scrollView.contentView.bounds.height, 1)
            let scrollY = max(scrollView.contentView.bounds.origin.y, 0)
            parent.scrollMetrics = EditorScrollMetrics(
                contentHeight: contentHeight,
                viewportHeight: viewportHeight,
                scrollY: scrollY
            )
            scrollbarView?.updateMetrics(
                ScrollbarMetrics(
                    contentLength: contentHeight,
                    viewportLength: viewportHeight,
                    offset: scrollY
                )
            )
            glyphFrameCache.invalidateIfNeeded(textView: textView, signature: parent.textLayoutSignature)
        }

        private func configureScrollbarActions(scrollView: NSScrollView, scrollbar: ScrollbarOverlayView) {
            scrollbar.onScrollToOffset = { [weak scrollView, weak scrollbar] offset in
                guard let scrollView else { return }
                let metrics = scrollbar?.metrics
                let maxOffset = max((metrics?.contentLength ?? 0) - (metrics?.viewportLength ?? 0), 0)
                let clamped = min(max(offset, 0), maxOffset)
                var origin = scrollView.contentView.bounds.origin
                origin.y = clamped
                scrollView.contentView.setBoundsOrigin(origin)
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }

            scrollbar.onPageScroll = { [weak scrollView, weak scrollbar] direction in
                guard let scrollView else { return }
                let metrics = scrollbar?.metrics
                let viewport = metrics?.viewportLength ?? scrollView.contentView.bounds.height
                let maxOffset = max((metrics?.contentLength ?? 0) - (metrics?.viewportLength ?? 0), 0)
                var origin = scrollView.contentView.bounds.origin
                origin.y = min(max(origin.y + viewport * CGFloat(direction), 0), maxOffset)
                scrollView.contentView.setBoundsOrigin(origin)
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
        }

        @objc private func handleMagnification(_ recognizer: NSMagnificationGestureRecognizer) {
            guard textView != nil else { return }
            switch recognizer.state {
            case .began:
                isPinching = true
                pinchStartFontSize = parent.fontSize
                pinchStartFont = parent.font
                liveFontSize = pinchStartFontSize
            case .changed:
                guard isPinching else { return }
                let targetSize = clampedFontSize(pinchStartFontSize * (1 + Double(recognizer.magnification)))
                if let liveFontSize, abs(targetSize - liveFontSize) < 0.1 {
                    return
                }
                liveFontSize = targetSize
                applyPreviewFontSize(targetSize)
            case .ended:
                guard isPinching else { return }
                let targetSize = clampedFontSize(pinchStartFontSize * (1 + Double(recognizer.magnification)))
                applyPreviewFontSize(targetSize)
                liveFontSize = nil
                pinchStartFont = nil
                isPinching = false
                if abs(parent.fontSize - targetSize) > 0.001 {
                    parent.fontSize = targetSize
                } else if let textView {
                    scheduleHighlight(textView: textView, text: textView.attributedString().string, delay: 0)
                }
            case .cancelled, .failed:
                guard isPinching else { return }
                applyPreviewFontSize(pinchStartFontSize)
                liveFontSize = nil
                pinchStartFont = nil
                isPinching = false
                if let textView {
                    scheduleHighlight(textView: textView, text: textView.attributedString().string, delay: 0)
                }
            default:
                break
            }
        }

        private func applyPreviewFontSize(_ size: Double) {
            guard let textView else { return }
            let baseFont = pinchStartFont ?? parent.font
            let previewFont = baseFont.withSize(CGFloat(size))
            textView.font = previewFont
            if let lineNumberView {
                lineNumberView.font = CodeEditor.lineNumberFont(for: previewFont)
                lineNumberView.invalidateHashMarks()
            }
            if let scrollView {
                updateScrollMetrics(textView: textView, scrollView: scrollView)
            }
            glyphFrameCache.invalidate()
            refreshCursorAppearance(textView: textView)
            refreshCursorPosition(textView: textView, restartBlink: false)
        }

        private func clampedFontSize(_ size: Double) -> Double {
            min(max(size, parent.minFontSize), parent.maxFontSize)
        }

        private func ensureCursorView(textView: STTextView) {
            if cursorView?.superview !== textView {
                let view = EditorCursorGroupView()
                view.cursorColor = parent.theme.foreground
                view.outlineColor = parent.theme.foreground.withAlphaComponent(0.6)
                view.showsOutlineWhenInactive = true
                view.setVisible(false)
                view.frame = textView.bounds
                view.autoresizingMask = [.width, .height]
                textView.addSubview(view, positioned: .above, relativeTo: nil)
                cursorView = view
            }
            updateCursorWindowObservation(for: textView)
        }

        func refreshCursorAppearance(textView: STTextView) {
            ensureCursorView(textView: textView)
            guard let cursorView else { return }
            cursorView.cursorColor = parent.theme.foreground
            cursorView.outlineColor = parent.theme.foreground.withAlphaComponent(0.6)
            cursorView.showsOutlineWhenInactive = true
        }

        func refreshCursorPosition(textView: STTextView, selection: NSRange? = nil, restartBlink: Bool) {
            ensureCursorView(textView: textView)
            guard let cursorView else { return }
            let selections = textView.textLayoutManager.textSelections
            guard !selections.isEmpty else {
                cursorView.setVisible(false)
                return
            }
            let isFirstResponder = textView.window?.firstResponder === textView
            guard isFirstResponder else {
                cursorView.setVisible(false)
                return
            }

            let windowIsKey = textView.window?.isKeyWindow ?? true
            cursorView.isActive = windowIsKey && isFirstResponder
            cursorView.blinkEnabled = cursorView.isActive

            let font = parent.font
            let baseLineHeight = ceil(font.ascender - font.descender + font.leading + CGFloat(parent.lineSpacing))
            let cursorWidth = CodeEditor.cursorWidth(for: font)
            let shape = parent.cursorStyle
            var targetRects: [NSRect] = []

            for selection in selections {
                for textRange in selection.textRanges {
                    let nsRange = NSRange(textRange, in: textView.textContentManager)
                    let insertionLocation = selection.affinity == .upstream
                        ? nsRange.location
                        : nsRange.location + nsRange.length
                    guard let caretRect = caretRect(for: textView, location: insertionLocation) else { continue }
                    let lineHeight = max(caretRect.height, baseLineHeight)
                    let cellWidth = cursorCellWidth(
                        textView: textView,
                        font: font,
                        characterSpacing: parent.characterSpacing,
                        location: insertionLocation
                    )
                    let targetRect = cursorRect(
                        caretRect: caretRect,
                        shape: shape,
                        cursorWidth: cursorWidth,
                        cellWidth: cellWidth,
                        lineHeight: lineHeight,
                        isFlipped: textView.isFlipped
                    )
                    targetRects.append(targetRect)
                }
            }

            if targetRects.isEmpty {
                cursorView.setVisible(false)
                return
            }

            cursorView.update(rects: targetRects, lineHeight: baseLineHeight, restartBlink: restartBlink)
        }

        private func updateCursorWindowObservation(for textView: STTextView) {
            guard cursorWindow !== textView.window else { return }
            cursorObservers.forEach { NotificationCenter.default.removeObserver($0) }
            cursorObservers.removeAll()
            cursorWindow = textView.window
            guard let window = cursorWindow else { return }
            let center = NotificationCenter.default
            let names: [Notification.Name] = [
                NSWindow.didBecomeKeyNotification,
                NSWindow.didResignKeyNotification,
                NSWindow.didBecomeMainNotification,
                NSWindow.didResignMainNotification,
            ]
            for name in names {
                let token = center.addObserver(forName: name, object: window, queue: .main) { [weak self, weak textView] _ in
                    guard let self, let textView else { return }
                    self.refreshCursorPosition(textView: textView, restartBlink: false)
                }
                cursorObservers.append(token)
            }
        }

        private func caretRect(for textView: STTextView, location: Int) -> NSRect? {
            let text = textView.attributedString().string as NSString
            let clamped = min(max(0, location), text.length)
            let range = NSRange(location: clamped, length: 0)
            let screenRect = textView.firstRect(forCharacterRange: range, actualRange: nil)
            if !screenRect.isNull, !screenRect.isInfinite, let window = textView.window {
                let windowRect = window.convertFromScreen(screenRect)
                return textView.convert(windowRect, from: nil)
            }
            let length = textView.attributedString().length
            guard length > 0 else { return nil }
            let resolved = max(0, min(clamped, max(0, length - 1)))
            if let rect = glyphFrameCache.frame(for: resolved, textView: textView) {
                return rect
            }
            return nil
        }

        private func cursorCellWidth(
            textView: STTextView,
            font: NSFont,
            characterSpacing: Double,
            location: Int
        ) -> CGFloat {
            let length = textView.attributedString().length
            if length > 0 {
                let clamped = max(0, min(location, max(0, length - 1)))
                if let rect = glyphFrameCache.frame(for: clamped, textView: textView),
                   rect.width > 0 {
                    return rect.width
                }
            }
            let sample = "M" as NSString
            let baseWidth = sample.size(withAttributes: [.font: font]).width
            let width = baseWidth + CGFloat(characterSpacing)
            return max(1, round(width))
        }

        private func cursorRect(
            caretRect: NSRect,
            shape: EditorCursorShape,
            cursorWidth: CGFloat,
            cellWidth: CGFloat,
            lineHeight: CGFloat,
            isFlipped: Bool
        ) -> NSRect {
            var rect = caretRect
            let height = max(1, lineHeight)
            if height != rect.height {
                rect.size.height = height
                if !isFlipped {
                    rect.origin.y = caretRect.maxY - height
                }
            }
            let lineRect = rect
            switch shape {
            case .bar:
                rect.size.width = max(1, cursorWidth)
            case .block:
                rect.size.width = max(cellWidth, cursorWidth)
            case .underline:
                rect.size.width = max(cellWidth, cursorWidth)
                let underlineHeight = max(1, round(cursorWidth))
                rect.size.height = underlineHeight
                rect.origin.y = isFlipped
                    ? lineRect.maxY - underlineHeight
                    : lineRect.minY
            }
            return rect
        }

        private func cursorMotionKind(
            from previous: NSRect?,
            to next: NSRect,
            lineHeight: CGFloat
        ) -> EditorCursorView.MotionKind {
            guard let previous else { return .short }
            let dx = next.minX - previous.minX
            let dy = next.minY - previous.minY
            let distance = hypot(dx, dy)
            let threshold = max(lineHeight * 2.5, 24)
            return distance > threshold ? .long : .short
        }

        func setTextViewContent(_ textView: STTextView, text: String) {
            let attrs = parent.baseTextAttributes()
            textView.font = parent.font
            textView.defaultParagraphStyle = parent.baseParagraphStyle()
            textView.setAttributedString(NSAttributedString(string: text, attributes: attrs))
            textView.typingAttributes = attrs
            lastAppliedText = text
            glyphFrameCache.invalidate()
        }

        func resetHighlighterCache() {
            highlighterCache = [:]
            highlighter = nil
        }

        func textViewDidChangeText(_ notification: Notification) {
            if ignoreNextChange {
                ignoreNextChange = false
                return
            }
            guard let textView = notification.object as? STTextView else { return }
            let newText = textView.attributedString().string
            parent.text = newText
            lastAppliedText = newText
            glyphFrameCache.invalidate()
            scheduleHighlight(textView: textView, text: newText, delay: 0.25)
            suppressSelectionCancel = true
            DispatchQueue.main.async { [weak self] in
                self?.suppressSelectionCancel = false
            }
            if let scrollView {
                updateScrollMetrics(textView: textView, scrollView: scrollView)
            }
            if let onTextEdit = parent.onTextEdit {
                let nsText = newText as NSString
                let insertionLocation = textView.selectedRange().location
                let clamped = min(max(0, insertionLocation), nsText.length)
                let position = lineAndColumn(in: nsText, location: clamped)
                onTextEdit(position.line, position.column)
            }
            updateGhostView(textView: textView)
            if suppressNextCompletionRequest {
                suppressNextCompletionRequest = false
            } else {
                scheduleCompletion(textView: textView)
            }
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.refreshCursorPosition(textView: textView, restartBlink: true)
            }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? STTextView else { return }
            normalizeSelectionsIfNeeded(textView: textView)
            let selection = textView.selectedRange()
            if !suppressSelectionCancel {
                cancelPendingCompletion()
                cancelInFlightCompletion()
            }
            if let ghostAnchor {
                if selection.length > 0 || selection.location != ghostAnchor {
                    clearGhostText(textView: textView)
                }
            }
            updateCursorPosition(textView: textView, selection: selection)
            if let scrollView {
                saveViewState(for: currentFileURL, textView: textView, scrollView: scrollView)
            }
            updateBracketHighlights(textView: textView, selection: selection)
            updateGhostView(textView: textView)
            refreshCursorPosition(textView: textView, selection: selection, restartBlink: true)
        }

        func textDidBeginEditing(_ notification: Notification) {
            guard let textView = notification.object as? STTextView else { return }
            refreshCursorPosition(textView: textView, restartBlink: false)
        }

        func textDidEndEditing(_ notification: Notification) {
            guard let textView = notification.object as? STTextView else { return }
            refreshCursorPosition(textView: textView, restartBlink: false)
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard let textView = textView as? STTextView else { return false }
            if commandSelector == #selector(NSResponder.insertTab(_:)) {
                if !ghostText.isEmpty {
                    applyGhostText(textView: textView)
                    return true
                }
                return false
            }
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                if !ghostText.isEmpty {
                    clearGhostText(textView: textView)
                    return true
                }
                cancelPendingCompletion()
                cancelInFlightCompletion()
                return false
            }
            if isNavigationCommand(commandSelector) {
                if !ghostText.isEmpty {
                    clearGhostText(textView: textView)
                }
                cancelPendingCompletion()
                cancelInFlightCompletion()
                return false
            }
            return false
        }

        func textView(
            _ textView: NSTextView,
            shouldChangeTextIn affectedCharRange: NSRange,
            replacementString: String?
        ) -> Bool {
            guard let textView = textView as? STTextView else { return true }
            if isApplyingCompletion {
                return true
            }
            cancelPendingCompletion()
            cancelInFlightCompletion()
            guard !ghostText.isEmpty else { return true }
            guard let replacementString, !replacementString.isEmpty, affectedCharRange.length == 0 else {
                clearGhostText(textView: textView)
                return true
            }
            if ghostText.hasPrefix(replacementString) {
                let dropCount = replacementString.count
                ghostText = String(ghostText.dropFirst(dropCount))
                let utf16Count = (replacementString as NSString).length
                ghostAnchor = affectedCharRange.location + utf16Count
                suppressNextCompletionRequest = true
                if ghostText.isEmpty {
                    clearGhostText(textView: textView)
                }
                return true
            }
            clearGhostText(textView: textView)
            return true
        }

        private func updateCursorPosition(textView: STTextView, selection: NSRange) {
            let nsText = textView.attributedString().string as NSString
            let insertionLocation = selection.location + selection.length
            let clampedLocation = min(max(0, insertionLocation), nsText.length)
            let position = lineAndColumn(in: nsText, location: clampedLocation)
            parent.onCursorMove(position.line, position.column)
        }

        private func lineAndColumn(in text: NSString, location: Int) -> (line: Int, column: Int) {
            let clampedLocation = min(max(0, location), text.length)
            let lineRange = text.lineRange(for: NSRange(location: clampedLocation, length: 0))
            let prefix = text.substring(to: clampedLocation)
            let line = prefix.components(separatedBy: "\n").count
            let column = clampedLocation - lineRange.location + 1
            return (line, column)
        }

        private func normalizeSelectionsIfNeeded(textView: STTextView) {
            guard !isNormalizingSelections else { return }
            let selections = textView.textLayoutManager.textSelections
            let totalRanges = selections.reduce(0) { $0 + $1.textRanges.count }
            guard totalRanges > 1 else { return }

            struct RangeKey: Hashable {
                let location: Int
                let length: Int
            }

            var seenEmpty: Set<Int> = []
            var seenRanges: Set<RangeKey> = []
            var uniqueSelections: [NSTextSelection] = []

            for selection in selections.reversed() {
                guard let textRange = selection.textRanges.last else { continue }
                let nsRange = NSRange(textRange, in: textView.textContentManager)
                if nsRange.length == 0 {
                    if seenEmpty.contains(nsRange.location) { continue }
                    seenEmpty.insert(nsRange.location)
                } else {
                    let key = RangeKey(location: nsRange.location, length: nsRange.length)
                    if seenRanges.contains(key) { continue }
                    seenRanges.insert(key)
                }
                uniqueSelections.append(selection)
            }

            uniqueSelections.reverse()
            guard uniqueSelections.count != selections.count else { return }

            isNormalizingSelections = true
            textView.textLayoutManager.textSelections = uniqueSelections
            textView.needsLayout = true
            textView.needsDisplay = true
            isNormalizingSelections = false
        }

        private func ensureGhostTextView(textView: STTextView) {
            if ghostTextView?.superview !== textView {
                let view = GhostTextOverlayView(frame: textView.bounds)
                view.autoresizingMask = [.width, .height]
                view.textColor = ghostTextColor()
                view.font = parent.font
                view.lineSpacing = CGFloat(parent.lineSpacing)
                view.characterSpacing = CGFloat(parent.characterSpacing)
                view.ligaturesEnabled = parent.ligaturesEnabled
                textView.addSubview(view, positioned: .above, relativeTo: nil)
                ghostTextView = view
            }
        }

        func updateGhostView(textView: STTextView) {
            ensureGhostTextView(textView: textView)
            guard let ghostTextView else { return }
            guard !ghostText.isEmpty, let anchor = ghostAnchor else {
                ghostTextView.ghostText = ""
                ghostTextView.setVisible(false)
                return
            }
            guard let caretRect = caretRect(for: textView, location: anchor) else {
                ghostTextView.setVisible(false)
                return
            }
            ghostTextView.ghostText = ghostText
            ghostTextView.caretRect = caretRect
            ghostTextView.lineStartX = lineStartX(for: textView, location: anchor)
            ghostTextView.font = parent.font
            ghostTextView.lineSpacing = CGFloat(parent.lineSpacing)
            ghostTextView.characterSpacing = CGFloat(parent.characterSpacing)
            ghostTextView.ligaturesEnabled = parent.ligaturesEnabled
            ghostTextView.textColor = ghostTextColor()
            ghostTextView.setVisible(true)
        }

        private func ghostTextColor() -> NSColor {
            parent.theme.foreground.withAlphaComponent(0.35)
        }

        private func lineStartX(for textView: STTextView, location: Int) -> CGFloat {
            let text = textView.attributedString().string as NSString
            let clamped = min(max(0, location), text.length)
            let lineRange = text.lineRange(for: NSRange(location: clamped, length: 0))
            if let rect = caretRect(for: textView, location: lineRange.location) {
                return rect.minX
            }
            return 0
        }

        private func setGhostText(_ text: String, anchor: Int, textView: STTextView) {
            ghostText = text
            ghostAnchor = anchor
            updateGhostView(textView: textView)
        }

        private func clearGhostText(textView: STTextView?) {
            ghostText = ""
            ghostAnchor = nil
            if let textView {
                updateGhostView(textView: textView)
            } else {
                ghostTextView?.ghostText = ""
                ghostTextView?.setVisible(false)
            }
        }

        private func resetCompletionState(textView: STTextView) {
            cancelPendingCompletion()
            cancelInFlightCompletion()
            clearGhostText(textView: textView)
        }

        private func applyGhostText(textView: STTextView) {
            guard !ghostText.isEmpty else { return }
            let insertion = ghostText
            clearGhostText(textView: textView)
            isApplyingCompletion = true
            textView.insertText(insertion, replacementRange: textView.selectedRange())
            isApplyingCompletion = false
        }

        private func cancelPendingCompletion() {
            completionWorkItem?.cancel()
            completionWorkItem = nil
        }

        private func cancelInFlightCompletion() {
            completionTask?.cancel()
            completionTask = nil
            parent.cancelCompletionRequest?()
            completionRequestID += 1
        }

        private func scheduleCompletion(textView: STTextView) {
            guard parent.completionProvider != nil else { return }
            guard parent.fileURL != nil else { return }
            guard textView.window?.firstResponder === textView else { return }
            let selection = textView.selectedRange()
            guard selection.length == 0 else { return }
            completionWorkItem?.cancel()
            completionRequestID += 1
            let requestID = completionRequestID
            let workItem = DispatchWorkItem { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.requestCompletion(textView: textView, requestID: requestID)
            }
            completionWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + completionDebounceInterval, execute: workItem)
        }

        private func requestCompletion(textView: STTextView, requestID: Int) {
            guard let provider = parent.completionProvider else { return }
            let selection = textView.selectedRange()
            guard selection.length == 0 else { return }
            let text = textView.attributedString().string
            let nsText = text as NSString
            let cursor = min(max(0, selection.location), nsText.length)
            let position = lineAndColumn(in: nsText, location: cursor)
            let request = EditorCompletionRequest(
                text: text,
                cursorOffset: cursor,
                line: position.line,
                column: position.column,
                fileURL: parent.fileURL,
                languageName: parent.language?.name
            )
            cancelInFlightCompletion()
            completionRequestID = requestID
            let anchor = cursor
            completionTask = Task { [weak self, weak textView] in
                guard let self, let textView else { return }
                let result = await provider(request, { partial in
                    Task { @MainActor in
                        guard self.completionRequestID == requestID else { return }
                        guard !partial.isEmpty else { return }
                        self.setGhostText(partial, anchor: anchor, textView: textView)
                    }
                })
                guard !Task.isCancelled else { return }
                guard self.completionRequestID == requestID else { return }
                if let result, !result.isEmpty, !self.isSuggestionRedundant(result, textView: textView, anchor: anchor) {
                    self.setGhostText(result, anchor: anchor, textView: textView)
                } else {
                    self.clearGhostText(textView: textView)
                }
            }
        }

        private func isSuggestionRedundant(_ suggestion: String, textView: STTextView, anchor: Int) -> Bool {
            let nsText = textView.attributedString().string as NSString
            let cursor = min(max(0, anchor), nsText.length)
            let suffix = nsText.substring(from: cursor)
            return suffix.hasPrefix(suggestion)
        }

        private func isNavigationCommand(_ selector: Selector) -> Bool {
            let commands: [Selector] = [
                #selector(NSResponder.moveLeft(_:)),
                #selector(NSResponder.moveRight(_:)),
                #selector(NSResponder.moveUp(_:)),
                #selector(NSResponder.moveDown(_:)),
                #selector(NSResponder.moveWordLeft(_:)),
                #selector(NSResponder.moveWordRight(_:)),
                #selector(NSResponder.moveToBeginningOfLine(_:)),
                #selector(NSResponder.moveToEndOfLine(_:)),
                #selector(NSResponder.moveToBeginningOfParagraph(_:)),
                #selector(NSResponder.moveToEndOfParagraph(_:)),
                #selector(NSResponder.moveToBeginningOfDocument(_:)),
                #selector(NSResponder.moveToEndOfDocument(_:)),
                #selector(NSResponder.pageUp(_:)),
                #selector(NSResponder.pageDown(_:)),
                #selector(NSResponder.scrollPageUp(_:)),
                #selector(NSResponder.scrollPageDown(_:)),
            ]
            return commands.contains(selector)
        }

        private func updateBracketHighlights(textView: STTextView, selection: NSRange) {
            guard selection.length == 0 else {
                clearBracketHighlights(textView: textView)
                return
            }
            let nsText = textView.attributedString().string as NSString
            let length = nsText.length
            guard length > 0 else {
                clearBracketHighlights(textView: textView)
                return
            }
            let cursor = min(max(0, selection.location), length)

            let openers: [UInt16: UInt16] = [40: 41, 91: 93, 123: 125]
            let closers: [UInt16: UInt16] = [41: 40, 93: 91, 125: 123]

            var matchPair: (current: Int, matching: Int)?

            if cursor > 0 {
                let prevChar = nsText.character(at: cursor - 1)
                if let closer = openers[prevChar] {
                    if let match = findMatchingBracket(
                        in: nsText,
                        start: cursor - 1,
                        opener: prevChar,
                        closer: closer,
                        forward: true
                    ) {
                        matchPair = (current: cursor - 1, matching: match)
                    }
                } else if let opener = closers[prevChar] {
                    if let match = findMatchingBracket(
                        in: nsText,
                        start: cursor - 1,
                        opener: opener,
                        closer: prevChar,
                        forward: false
                    ) {
                        matchPair = (current: cursor - 1, matching: match)
                    }
                }
            }

            if matchPair == nil, cursor < length {
                let nextChar = nsText.character(at: cursor)
                if let closer = openers[nextChar] {
                    if let match = findMatchingBracket(
                        in: nsText,
                        start: cursor,
                        opener: nextChar,
                        closer: closer,
                        forward: true
                    ) {
                        matchPair = (current: cursor, matching: match)
                    }
                } else if let opener = closers[nextChar] {
                    if let match = findMatchingBracket(
                        in: nsText,
                        start: cursor,
                        opener: opener,
                        closer: nextChar,
                        forward: false
                    ) {
                        matchPair = (current: cursor, matching: match)
                    }
                }
            }

            guard let matchPair else {
                clearBracketHighlights(textView: textView)
                return
            }
            applyBracketHighlights(textView: textView, ranges: [
                NSRange(location: matchPair.current, length: 1),
                NSRange(location: matchPair.matching, length: 1),
            ])
        }

        private func findMatchingBracket(
            in text: NSString,
            start: Int,
            opener: UInt16,
            closer: UInt16,
            forward: Bool
        ) -> Int? {
            let length = text.length
            let maxScan = 10_000
            var depth = 1
            if forward {
                var scanned = 0
                var index = start + 1
                while index < length {
                    let ch = text.character(at: index)
                    if ch == opener { depth += 1 }
                    if ch == closer {
                        depth -= 1
                        if depth == 0 { return index }
                    }
                    index += 1
                    scanned += 1
                    if scanned >= maxScan { break }
                }
            } else {
                var scanned = 0
                var index = start - 1
                while index >= 0 {
                    let ch = text.character(at: index)
                    if ch == closer { depth += 1 }
                    if ch == opener {
                        depth -= 1
                        if depth == 0 { return index }
                    }
                    index -= 1
                    scanned += 1
                    if scanned >= maxScan { break }
                }
            }
            return nil
        }

        private func clearBracketHighlights(textView: STTextView) {
            guard let storage = (textView.textContentManager as? NSTextContentStorage)?.textStorage else { return }
            for range in bracketHighlightRanges {
                storage.removeAttribute(.backgroundColor, range: range)
            }
            bracketHighlightRanges = []
        }

        private func applyBracketHighlights(textView: STTextView, ranges: [NSRange]) {
            guard let storage = (textView.textContentManager as? NSTextContentStorage)?.textStorage else { return }
            clearBracketHighlights(textView: textView)
            let color = parent.theme.matchingBracket
            for range in ranges {
                guard range.location >= 0,
                      range.location + range.length <= storage.length else { continue }
                storage.addAttribute(.backgroundColor, value: color, range: range)
                bracketHighlightRanges.append(range)
            }
        }

        fileprivate func scheduleHighlight(textView: STTextView, text: String, delay: TimeInterval) {
            highlightWorkItem?.cancel()
            var workItem: DispatchWorkItem?
            workItem = DispatchWorkItem { [weak self, weak textView] in
                guard let self, let textView, let workItem, !workItem.isCancelled else { return }
                self.highlighter?.highlight(text: text, textView: textView)
            }
            highlightWorkItem = workItem
            if delay > 0 {
                if let workItem {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
                }
            } else {
                if let workItem {
                    DispatchQueue.main.async(execute: workItem)
                }
            }
        }
    }
}

private final class IndentGuidesView: NSView {
    var indentWidth: CGFloat = 24 {
        didSet { needsDisplay = true }
    }
    var lineColor: NSColor = NSColor.white.withAlphaComponent(0.06) {
        didSet { needsDisplay = true }
    }
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard indentWidth > 0 else { return }
        let path = NSBezierPath()
        var x = indentWidth
        while x < bounds.width {
            path.move(to: CGPoint(x: x + 0.5, y: 0))
            path.line(to: CGPoint(x: x + 0.5, y: bounds.height))
            x += indentWidth
        }
        lineColor.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}

struct ContentView: View {
    enum FocusedPane {
        case sidebar
        case editor
        case chat
        case terminal
        case diff
    }

    @ObservedObject var workspace: WorkspaceState
    @ObservedObject var tmuxKeyHandler: TmuxKeyHandler
    @State private var focusedPane: FocusedPane? = .editor
    @State private var editorViewStates: [URL: EditorViewState] = [:]
    @State private var editorScrollMetrics = EditorScrollMetrics()
#if DEBUG
    @StateObject private var performanceMonitor = PerformanceMonitor.shared
#endif
    private let shortcutsPanelWidth: CGFloat = 200

    var body: some View {
        let selectionKey = workspace.selectedFileURL?.absoluteString ?? "empty"
        let statusBarHeight: CGFloat = 22
        let isChatActive = workspace.selectedFileURL.map(workspace.isChatURL) ?? false
        let toastBottomPadding = statusBarHeight + (isChatActive ? 64 : 16)
        let toastTransition = AnyTransition.asymmetric(
            insertion: .move(edge: .bottom)
                .combined(with: .opacity)
                .animation(.easeOut(duration: 0.25)),
            removal: .move(edge: .bottom)
                .combined(with: .opacity)
                .animation(.easeIn(duration: 0.15))
        )

        ZStack {
            NavigationSplitView(columnVisibility: $workspace.sidebarVisibility) {
                FileTreeSidebar(workspace: workspace)
                    .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 400)
                    .overlay(SidebarResizeHandle(theme: workspace.theme), alignment: .trailing)
                    .overlay(FocusRing(isActive: focusedPane == .sidebar, theme: workspace.theme))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        focusedPane = .sidebar
                    }
            } detail: {
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                    if !workspace.openFiles.isEmpty {
                        TabBar(workspace: workspace)
                        Divider()
                            .background(workspace.theme.dividerColor)
                    }

                    if let selectedURL = workspace.selectedFileURL,
                       workspace.isRegularFileURL(selectedURL) {
                        BreadcrumbBar(path: workspace.displayPath(for: selectedURL), theme: workspace.theme)
                        Divider()
                            .background(workspace.theme.dividerColor)
                    }

                    Group {
                        if let selectedURL = workspace.selectedFileURL {
                            if workspace.isChatURL(selectedURL) {
                                pane(
                                    ChatView(workspace: workspace, onFocusChange: { focused in
                                        if focused { focusedPane = .chat }
                                    }),
                                    pane: .chat
                                )
                            } else if workspace.isTerminalURL(selectedURL) {
                                if let view = workspace.terminalViews[selectedURL] {
                                    pane(
                                        TerminalTabView(
                                            view: view,
                                            scrollbarMode: workspace.scrollbarVisibilityMode,
                                            theme: workspace.theme
                                        ),
                                        pane: .terminal
                                    )
                                } else {
                                    pane(emptyEditor, pane: .editor)
                                }
                            } else if workspace.isDiffURL(selectedURL) {
                                if let tab = workspace.diffTab(for: selectedURL) {
                                    pane(
                                        DiffViewer(
                                            title: tab.title,
                                            summary: tab.summary,
                                            diff: tab.diff,
                                            theme: workspace.theme
                                        ),
                                        pane: .diff
                                    )
                                } else {
                                    pane(emptyEditor, pane: .editor)
                                }
                            } else {
                                if workspace.isNvimModeEnabled {
                                    if let failure = workspace.nvimFailure {
                                        pane(
                                            NvimRecoveryView(
                                                failure: failure,
                                                theme: workspace.theme,
                                                onRestart: { workspace.restartNvim() },
                                                onDisable: { workspace.toggleNvimMode() },
                                                onRevealReport: { url in
                                                    workspace.revealInFinder(url)
                                                }
                                            ),
                                            pane: .editor
                                        )
                                    } else if let nvimView = workspace.nvimTerminalView {
                                        pane(
                                            TerminalTabView(
                                                view: nvimView,
                                                scrollbarMode: workspace.scrollbarVisibilityMode,
                                                scrollbarMetrics: nvimScrollbarMetrics,
                                                theme: workspace.theme,
                                                floatingWindowEffects: workspace.nvimFloatingWindowEffects,
                                                onScrollToOffset: { offset in
                                                    let topLine = Int(offset.rounded()) + 1
                                                    workspace.scrollNvimToTopLine(topLine)
                                                },
                                                onPageScroll: { direction in
                                                    let lines = workspace.nvimViewport?.visibleLineCount ?? 1
                                                    workspace.scrollNvimByLines(lines * direction)
                                                }
                                            ),
                                            pane: .terminal
                                        )
                                    } else {
                                        pane(nvimPlaceholder, pane: .editor)
                                    }
                                } else {
                                    pane(editorView, pane: .editor)
                                }
                            }
                        } else {
                            pane(emptyEditor, pane: .editor)
                        }
                    }
                    .id(selectionKey)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.1), value: selectionKey)

                    StatusBar(workspace: workspace, height: statusBarHeight)
                }

                if workspace.isShortcutsPanelVisible {
                    Divider()
                        .background(workspace.theme.dividerColor)
                    KeyboardShortcutsPanel(workspace: workspace, tmuxKeyHandler: tmuxKeyHandler)
                        .frame(width: shortcutsPanelWidth)
                        .frame(maxHeight: .infinity)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
                }
            }
            .navigationTitle("")

            if workspace.isSearchPresented {
                SearchPanelOverlay(workspace: workspace)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(1)
            }

            if workspace.isCommandPalettePresented {
                CommandPaletteView(workspace: workspace)
                    .transition(.scale(scale: 0.97, anchor: .top).combined(with: .opacity))
                    .zIndex(2)
            }

            if let toast = workspace.toastMessage {
                VStack {
                    Spacer()
                    ToastView(message: toast, theme: workspace.theme)
                        .padding(.bottom, toastBottomPadding)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(toastTransition)
                .allowsHitTesting(false)
                .zIndex(3)
            }

            if workspace.isProgressBarVisible {
                VStack(spacing: 0) {
                    WindowProgressBar(
                        progress: workspace.progressValue,
                        height: max(CGFloat(1), workspace.progressBarHeight),
                        fillColor: Color(nsColor: workspace.progressBarFillColor ?? workspace.theme.accent),
                        trackColor: Color(nsColor: workspace.progressBarTrackColor
                            ?? workspace.theme.divider.withAlphaComponent(0.35))
                    )
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .transition(.opacity)
                .allowsHitTesting(false)
                .zIndex(4)
            }

#if DEBUG
            if workspace.isPerformanceOverlayEnabled {
                PerformanceOverlayView(monitor: performanceMonitor, theme: workspace.theme)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.top, 10)
                    .padding(.trailing, 12)
                    .transition(.opacity)
                    .allowsHitTesting(false)
                    .zIndex(5)
            }

            if workspace.isPerformanceOverlayEnabled || workspace.isPerformanceLoggingEnabled {
                PerformanceFrameTicker(monitor: performanceMonitor)
                    .frame(width: 0, height: 0)
                    .allowsHitTesting(false)
            }
#endif

            // Hidden accessibility element for test observability of nvim active file.
            // Uses .accessibilityHidden(false) to ensure XCUITest can find it despite zero size.
            if workspace.isNvimModeEnabled {
                Text(workspace.nvimCurrentFilePath ?? "(none)")
                    .frame(width: 0, height: 0)
                    .clipped()
                    .accessibilityIdentifier("NvimCurrentFilePath")
                    .accessibilityHidden(false)
            }
        }
        .animation(.spring(duration: 0.25, bounce: 0.15), value: workspace.isCommandPalettePresented)
        .animation(.easeInOut(duration: 0.2), value: workspace.isProgressBarVisible)
        .animation(.easeInOut(duration: 0.2), value: workspace.isShortcutsPanelVisible)
        .background(workspace.theme.backgroundColor)
    }

    private func pane<Content: View>(_ content: Content, pane: FocusedPane) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(FocusRing(isActive: focusedPane == pane, theme: workspace.theme))
            .contentShape(Rectangle())
            .onTapGesture {
                focusedPane = pane
            }
    }

    private var nvimScrollbarMetrics: ScrollbarMetrics? {
        guard let viewport = workspace.nvimViewport else { return nil }
        let contentLength = max(1, viewport.lineCount)
        let viewportLength = max(1, viewport.visibleLineCount)
        let offset = max(0, viewport.topLine - 1)
        return ScrollbarMetrics(
            contentLength: CGFloat(contentLength),
            viewportLength: CGFloat(viewportLength),
            offset: CGFloat(offset)
        )
    }

    private var editorView: some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                CodeEditor(
                    text: $workspace.editorText,
                    selectionRequest: $workspace.pendingSelection,
                    scrollMetrics: $editorScrollMetrics,
                    fontSize: $workspace.editorFontSize,
                    language: workspace.currentLanguage,
                    fileURL: workspace.selectedFileURL,
                    theme: workspace.theme,
                    font: workspace.editorFont,
                    lineSpacing: workspace.editorLineSpacing,
                    characterSpacing: workspace.editorCharacterSpacing,
                    ligaturesEnabled: workspace.editorLigaturesEnabled,
                    scrollbarMode: workspace.scrollbarVisibilityMode,
                    showsLineNumbers: true,
                    highlightsCurrentLine: true,
                    showsIndentGuides: true,
                    minFontSize: WorkspaceState.minEditorFontSize,
                    maxFontSize: WorkspaceState.maxEditorFontSize,
                    saveViewState: { url, scrollOrigin, selection in
                        editorViewStates[url] = EditorViewState(
                            scrollOrigin: scrollOrigin,
                            selectionRange: selection
                        )
                    },
                    loadViewState: { url in
                        editorViewStates[url]
                    },
                    onCursorMove: { line, column in
                        workspace.cursorLine = line
                        workspace.cursorColumn = column
                        focusedPane = .editor
                    },
                    onTextEdit: { line, column in
                        workspace.recordEditorEdit(line: line, column: column)
                    },
                    completionProvider: { request, onPartial in
                        await workspace.requestEditorCompletion(request, onPartial: onPartial)
                    },
                    cancelCompletionRequest: {
                        workspace.cancelEditorCompletion()
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if workspace.showMinimap {
                    MinimapView(metrics: editorScrollMetrics, theme: workspace.theme)
                        .frame(width: 70)
                }
            }

            if workspace.isEditorLoading {
                EditorSkeleton(theme: workspace.theme)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: workspace.isEditorLoading)
    }

    private var emptyEditor: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.text")
                .font(.system(size: Typography.iconL))
                .foregroundStyle(.tertiary)
            Text("Select a file to edit")
                .font(.system(size: Typography.l, weight: .semibold))
                .foregroundStyle(.secondary)
            VStack(spacing: 6) {
                emptyStateShortcut("Open Folder", "⌘⇧O")
                emptyStateShortcut("Go to File", "⌘P")
                emptyStateShortcut("Search in Files", "⌘⇧F")
                emptyStateShortcut("New Terminal", "⌘`")
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(workspace.theme.backgroundColor)
    }

    private var nvimPlaceholder: some View {
        VStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Starting Neovim...")
                .font(.system(size: Typography.l, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(workspace.theme.backgroundColor)
    }

    private func emptyStateShortcut(_ title: String, _ keys: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(keys)
                .font(.system(size: Typography.s, weight: .semibold, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: 260)
    }
}

private struct NvimRecoveryView: View {
    let failure: NvimFailure
    let theme: AppTheme
    let onRestart: () -> Void
    let onDisable: () -> Void
    let onRevealReport: ((URL) -> Void)?

    private var title: String {
        switch failure.kind {
        case .startup:
            return "Neovim Failed to Start"
        case .crash:
            return "Neovim Closed"
        }
    }

    private var iconName: String {
        switch failure.kind {
        case .startup:
            return "xmark.octagon.fill"
        case .crash:
            return "exclamationmark.triangle.fill"
        }
    }

    var body: some View {
        VStack {
            VStack(spacing: 12) {
                Image(systemName: iconName)
                    .font(.system(size: Typography.iconL))
                    .foregroundStyle(theme.accentColor)

                Text(title)
                    .font(.system(size: Typography.xl, weight: .semibold))
                    .foregroundStyle(theme.foregroundColor)

                Text(failure.message)
                    .font(.system(size: Typography.base))
                    .foregroundStyle(theme.mutedForegroundColor)
                    .multilineTextAlignment(.center)

                if let detail = failure.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: Typography.s))
                        .foregroundStyle(theme.mutedForegroundColor)
                        .multilineTextAlignment(.center)
                }

                if let reportURL = failure.reportURL {
                    VStack(spacing: 4) {
                        Text("Report saved to:")
                            .font(.system(size: Typography.s, weight: .medium))
                            .foregroundStyle(theme.mutedForegroundColor)
                        Text(reportURL.path)
                            .font(.system(size: Typography.xs, design: .monospaced))
                            .foregroundStyle(theme.mutedForegroundColor)
                            .multilineTextAlignment(.center)
                            .lineLimit(3)
                            .truncationMode(.middle)
                    }
                }

                HStack(spacing: 10) {
                    Button("Restart Neovim", action: onRestart)
                        .buttonStyle(.borderedProminent)
                    if let reportURL = failure.reportURL {
                        Button("Reveal Report") {
                            onRevealReport?(reportURL)
                        }
                        .buttonStyle(.bordered)
                    }
                    Button("Disable Neovim Mode", action: onDisable)
                        .buttonStyle(.bordered)
                }
            }
            .padding(24)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(theme.panelBackgroundColor)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(theme.panelBorderColor)
            )
            .frame(maxWidth: 520)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.backgroundColor)
    }
}

private struct FocusRing: View {
    let isActive: Bool
    let theme: AppTheme

    var body: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .strokeBorder(isActive ? theme.accentColor.opacity(0.35) : Color.clear, lineWidth: 2)
    }
}

private struct SidebarResizeHandle: View {
    let theme: AppTheme

    var body: some View {
        VStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { _ in
                Circle()
                    .frame(width: 3, height: 3)
            }
        }
        .foregroundStyle(theme.mutedForegroundColor.opacity(0.5))
        .frame(width: 10)
        .padding(.vertical, 12)
        .allowsHitTesting(false)
    }
}

private struct BreadcrumbBar: View {
    let path: String
    let theme: AppTheme

    var body: some View {
        let parts = path.split(separator: "/").map(String.init)
        HStack(spacing: 6) {
            if parts.isEmpty {
                Text("Workspace")
                    .font(.system(size: Typography.s, weight: .medium))
                    .foregroundStyle(theme.mutedForegroundColor)
            } else {
                ForEach(parts.indices, id: \.self) { index in
                    Text(parts[index])
                        .font(.system(size: Typography.s, weight: index == parts.count - 1 ? .semibold : .regular))
                        .foregroundStyle(index == parts.count - 1
                            ? theme.foregroundColor
                            : theme.mutedForegroundColor)
                    if index < parts.count - 1 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: Typography.xs, weight: .semibold))
                            .foregroundStyle(theme.mutedForegroundColor.opacity(0.8))
                    }
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(theme.secondaryBackgroundColor)
    }
}

private struct StatusBar: View {
    @ObservedObject var workspace: WorkspaceState
    let height: CGFloat

    var body: some View {
        let theme = workspace.theme
        let selectedURL = workspace.selectedFileURL
        let isRegular = selectedURL.map(workspace.isRegularFileURL) ?? false
        let viewLabel: String = {
            guard let selectedURL else { return "No file" }
            if workspace.isChatURL(selectedURL) { return "Chat" }
            if workspace.isTerminalURL(selectedURL) { return "Terminal" }
            if workspace.isDiffURL(selectedURL) { return "Diff" }
            return "Editor"
        }()

        HStack(spacing: 12) {
            if isRegular {
                Text("Ln \(workspace.cursorLine), Col \(workspace.cursorColumn)")
                    .font(.system(size: Typography.s, weight: .medium, design: .monospaced))
                Text("UTF-8")
                Text("LF")
            } else {
                Text(viewLabel)
                    .font(.system(size: Typography.s, weight: .medium))
            }

            Spacer()

            Text(workspace.currentLanguage?.name ?? "Plain Text")
            Text("Spaces: 4")
        }
        .font(.system(size: Typography.s, weight: .regular))
        .foregroundStyle(theme.mutedForegroundColor)
        .padding(.horizontal, 12)
        .frame(height: height)
        .background(theme.secondaryBackgroundColor)
    }
}

private struct EditorSkeleton: View {
    let theme: AppTheme
    @State private var shimmer = false

    var body: some View {
        GeometryReader { proxy in
            let widths: [CGFloat] = [0.65, 0.9, 0.55, 0.82, 0.7, 0.6, 0.88, 0.5, 0.78, 0.62, 0.86, 0.57]
            VStack(alignment: .leading, spacing: 6) {
                ForEach(widths.indices, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(theme.foregroundColor.opacity(0.06))
                        .frame(width: proxy.size.width * widths[index], height: 12)
                }
                Spacer()
            }
            .padding(16)
            .opacity(shimmer ? 0.55 : 1)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: shimmer)
            .onAppear { shimmer = true }
        }
        .background(theme.backgroundColor)
    }
}

private struct MinimapView: View {
    let metrics: EditorScrollMetrics
    let theme: AppTheme

    var body: some View {
        GeometryReader { proxy in
            let total = max(metrics.contentHeight, 1)
            let viewportRatio = min(1, metrics.viewportHeight / total)
            let scrollable = max(total - metrics.viewportHeight, 1)
            let scrollRatio = min(1, metrics.scrollY / scrollable)
            let indicatorHeight = max(24, proxy.size.height * viewportRatio)
            let indicatorY = (proxy.size.height - indicatorHeight) * scrollRatio

            ZStack(alignment: .top) {
                Rectangle()
                    .fill(theme.panelBackgroundColor)
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(theme.accentColor.opacity(0.18))
                    .overlay(
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .stroke(theme.accentColor.opacity(0.35), lineWidth: 1)
                    )
                    .frame(height: indicatorHeight)
                    .offset(y: indicatorY)
                    .padding(.horizontal, 6)
            }
        }
        .background(theme.panelBackgroundColor)
        .overlay(
            Rectangle()
                .fill(theme.panelBorderColor.opacity(0.4))
                .frame(width: 1),
            alignment: .leading
        )
        .allowsHitTesting(false)
    }
}

private struct WindowProgressBar: View {
    let progress: Double
    let height: CGFloat
    let fillColor: Color
    let trackColor: Color

    private var clampedProgress: CGFloat {
        CGFloat(min(max(progress, 0), 1))
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(trackColor)
                Rectangle()
                    .fill(fillColor)
                    .frame(width: proxy.size.width * clampedProgress)
            }
        }
        .frame(height: height)
        .clipped()
        .accessibilityIdentifier("WindowProgressBar")
        .animation(.easeInOut(duration: 0.2), value: clampedProgress)
    }
}

private struct ToastView: View {
    let message: String
    let theme: AppTheme

    var body: some View {
        Text(message)
            .font(.system(size: Typography.base, weight: .semibold))
            .foregroundStyle(theme.foregroundColor)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(theme.panelBackgroundColor)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(theme.panelBorderColor)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
            .accessibilityIdentifier("ToastMessage")
    }
}

struct TabBar: View {
    @ObservedObject var workspace: WorkspaceState
    @State private var dragTarget: URL?

    var body: some View {
        let theme = workspace.theme
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 6) {
                    ForEach(workspace.openFiles, id: \.self) { url in
                        tabItem(for: url, theme: theme)
                    }
                }
                .animation(.easeInOut(duration: 0.15), value: workspace.openFiles)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }

            Menu {
                Section("Switch To") {
                    ForEach(workspace.openFiles, id: \.self) { url in
                        Button {
                            workspace.selectFile(url)
                        } label: {
                            Label(tabTitle(for: url), systemImage: tabIcon(for: url))
                        }
                    }
                }
                Section("Close") {
                    ForEach(workspace.openFiles, id: \.self) { url in
                        Button(role: .destructive) {
                            workspace.requestCloseFile(url)
                        } label: {
                            Text("Close \(tabTitle(for: url))")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: Typography.base, weight: .medium))
                    .foregroundStyle(theme.mutedForegroundColor)
            }
            .buttonStyle(.borderless)
            .help("All tabs")
            .padding(.trailing, 8)
        }
        .accessibilityIdentifier("EditorTabBar")
        .background(theme.tabBarBackgroundColor)
    }

    private func handleDrop(_ items: [String], target: URL) -> Bool {
        guard let item = items.first, let source = URL(string: item) else { return false }
        workspace.moveTab(from: source, to: target)
        return true
    }

    @ViewBuilder
    private func tabItem(for url: URL, theme: AppTheme) -> some View {
        if workspace.isTerminalURL(url),
           let view = workspace.terminalViews[url] {
            tabItemModifiers(
                TerminalTabBarItem(
                    view: view,
                    isSelected: url == workspace.selectedFileURL,
                    theme: theme,
                    onSelect: { workspace.selectFile(url) },
                    onClose: { workspace.requestCloseFile(url) }
                ),
                url: url,
                theme: theme
            )
        } else {
            let isChat = workspace.isChatURL(url)
            let isDiff = workspace.isDiffURL(url)
            let diffInfo = isDiff ? workspace.diffTab(for: url) : nil
            let diffSubtitle = diffInfo?.summary.isEmpty == false ? diffInfo?.summary : "Diff view"
            let isModified = workspace.isFileModified(url)
            tabItemModifiers(
                TabBarItem(
                    title: isChat ? "Chat" : (diffInfo?.title ?? url.lastPathComponent),
                    subtitle: isChat ? "Current chat" : (diffSubtitle ?? workspace.displayPath(for: url)),
                    icon: isChat ? "bubble.left.and.bubble.right" : (isDiff ? "arrow.left.and.right" : iconForFile(url.lastPathComponent)),
                    isSelected: url == workspace.selectedFileURL,
                    isModified: isModified,
                    isDropTarget: dragTarget == url,
                    theme: theme,
                    onSelect: {
                        workspace.selectFile(url)
                    },
                    onClose: {
                        workspace.requestCloseFile(url)
                    }
                ),
                url: url,
                theme: theme
            )
        }
    }

    @ViewBuilder
    private func tabItemModifiers<Content: View>(_ content: Content, url: URL, theme: AppTheme) -> some View {
        content
            .transition(.scale(scale: 0.8, anchor: .leading).combined(with: .opacity))
            .contextMenu { tabContextMenu(for: url) }
            .draggable(url.absoluteString) {
                tabDragPreview(for: url, theme: theme)
            }
            .dropDestination(
                for: String.self,
                action: { items, _ in
                    handleDrop(items, target: url)
                },
                isTargeted: { isTargeted in
                    dragTarget = isTargeted ? url : nil
                }
            )
    }

    @ViewBuilder
    private func tabDragPreview(for url: URL, theme: AppTheme) -> some View {
        Text(tabTitle(for: url))
            .font(.system(size: Typography.s, weight: .medium))
            .padding(4)
            .background(theme.tabSelectedBackgroundColor)
            .cornerRadius(4)
    }

    @ViewBuilder
    private func tabContextMenu(for url: URL) -> some View {
        Button("Close") { workspace.requestCloseFile(url) }
        Button("Close Others") { workspace.closeAllExcept(url) }
        Button("Close All") { workspace.closeAllTabs() }
        Button("Close to the Right") { workspace.closeTabsToRight(of: url) }
        if workspace.isRegularFileURL(url) {
            Divider()
            Button("Copy Path") { workspace.copyFilePath(url) }
            Button("Reveal in Finder") { workspace.revealInFinder(url) }
            Button("Reveal in Sidebar") { workspace.selectFile(url) }
        }
    }

    private func tabTitle(for url: URL) -> String {
        if workspace.isChatURL(url) {
            return "Chat"
        }
        if workspace.isTerminalURL(url) {
            let title = workspace.terminalViews[url]?.title ?? ""
            return title.isEmpty ? "Terminal" : title
        }
        if workspace.isDiffURL(url) {
            return workspace.diffTab(for: url)?.title ?? "Diff"
        }
        return url.lastPathComponent
    }

    private func tabIcon(for url: URL) -> String {
        if workspace.isChatURL(url) {
            return "bubble.left.and.bubble.right"
        }
        if workspace.isTerminalURL(url) {
            return "terminal"
        }
        if workspace.isDiffURL(url) {
            return "arrow.left.and.right"
        }
        return iconForFile(url.lastPathComponent)
    }
}
