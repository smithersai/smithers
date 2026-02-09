import SwiftUI
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
    var minFontSize: Double
    var maxFontSize: Double
    var saveViewState: (URL, CGPoint, NSRange) -> Void
    var loadViewState: (URL) -> EditorViewState?
    var onCursorMove: (Int, Int) -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = STTextView.scrollableTextView()
        let textView = scrollView.documentView as! STTextView

        textView.font = font
        textView.backgroundColor = theme.background
        textView.insertionPointColor = theme.foreground
        textView.insertionPointWidth = 2
        textView.highlightSelectedLine = true
        textView.selectedLineHighlightColor = theme.lineHighlight
        textView.widthTracksTextView = true
        textView.textColor = theme.foreground
        textView.delegate = context.coordinator
        let rulerView = STLineNumberRulerView(textView: textView)
        rulerView.font = Self.lineNumberFont(for: font)
        rulerView.backgroundColor = theme.lineNumberBackground
        rulerView.textColor = theme.lineNumberForeground
        rulerView.highlightSelectedLine = true
        rulerView.selectedLineTextColor = theme.lineNumberSelectedForeground
        rulerView.drawSeparator = false
        rulerView.rulerInsets = STRulerInsets(leading: 8, trailing: 8)
        scrollView.verticalRulerView = rulerView
        scrollView.rulersVisible = true

        scrollView.backgroundColor = theme.background
        scrollView.scrollerStyle = .overlay
        scrollView.contentView.postsBoundsChangedNotifications = true
        scrollView.setAccessibilityIdentifier("CodeEditor")
        textView.setAccessibilityIdentifier("CodeEditorTextView")

        context.coordinator.attach(scrollView: scrollView, textView: textView)
        context.coordinator.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
        context.coordinator.appliedTheme = theme
        context.coordinator.appliedFont = font

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? STTextView else { return }
        let coord = context.coordinator
        coord.parent = self

        if coord.appliedTheme != theme {
            let previousTheme = coord.appliedTheme
            applyTheme(theme, previousTheme: previousTheme, to: textView, scrollView: scrollView)
            coord.appliedTheme = theme
        }

        if coord.currentFileURL != fileURL {
            coord.saveViewState(for: coord.currentFileURL, textView: textView, scrollView: scrollView)
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            coord.restoreViewState(for: fileURL, textView: textView, scrollView: scrollView)
            coord.updateScrollMetrics(textView: textView, scrollView: scrollView)
            applySelectionRequest(textView: textView, scrollView: scrollView)
            return
        }

        if let appliedFont = coord.appliedFont, appliedFont != font {
            coord.appliedFont = font
            coord.resetHighlighterCache()
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            updateLineNumberFont(font, scrollView: scrollView)
            return
        }

        if coord.lastAppliedText != text {
            coord.ignoreNextChange = true
            coord.setTextViewContent(textView, text: text)
            coord.scheduleHighlight(textView: textView, text: text, delay: 0)
        }

        applySelectionRequest(textView: textView, scrollView: scrollView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
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
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else {
            textView.scrollRangeToVisible(range)
            return
        }
        let glyphRange = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let targetRect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
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
        textView.insertionPointColor = theme.foreground
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

    @MainActor class Coordinator: NSObject, STTextViewDelegate {
        var parent: CodeEditor
        var ignoreNextChange = false
        var highlighter: TreeSitterHighlighter?
        var currentFileURL: URL?
        weak var scrollView: NSScrollView?
        weak var textView: STTextView?
        private weak var lineNumberView: STLineNumberRulerView?
        private var scrollObserver: Any?
        private var magnificationRecognizer: NSMagnificationGestureRecognizer?
        private var highlighterCache: [String: TreeSitterHighlighter] = [:]
        private var highlightWorkItem: DispatchWorkItem?
        fileprivate var lastAppliedText: String = ""
        var appliedTheme: AppTheme?
        var appliedFont: NSFont?
        private var bracketHighlightRanges: [NSRange] = []
        private var pinchStartFontSize: Double = 0
        private var pinchStartFont: NSFont?
        private var liveFontSize: Double?
        private var isPinching = false

        init(parent: CodeEditor) {
            self.parent = parent
        }

        deinit {
            if let scrollObserver {
                NotificationCenter.default.removeObserver(scrollObserver)
            }
        }

        func attach(scrollView: NSScrollView, textView: STTextView) {
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
            }
        }

        func loadFile(text: String, language: SupportedLanguage?, fileURL: URL?, textView: STTextView) {
            currentFileURL = fileURL
            ignoreNextChange = true
            appliedFont = parent.font
            setTextViewContent(textView, text: text)

            if let language {
                if let cached = highlighterCache[language.name] {
                    highlighter = cached
                } else {
                    let h = TreeSitterHighlighter(language: language, font: parent.font)
                    highlighterCache[language.name] = h
                    highlighter = h
                }
                scheduleHighlight(textView: textView, text: text, delay: 0)
            } else {
                highlighter = nil
            }
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
        }

        func setTextViewContent(_ textView: STTextView, text: String) {
            let attrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: parent.theme.foreground,
                .font: parent.font,
            ]
            textView.font = parent.font
            textView.setAttributedString(NSAttributedString(string: text, attributes: attrs))
            textView.typingAttributes = attrs
            lastAppliedText = text
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
            scheduleHighlight(textView: textView, text: newText, delay: 0.25)
            if let scrollView {
                updateScrollMetrics(textView: textView, scrollView: scrollView)
            }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let textView = notification.object as? STTextView else { return }
            let selection = textView.selectedRange()
            updateCursorPosition(textView: textView, selection: selection)
            if let scrollView {
                saveViewState(for: currentFileURL, textView: textView, scrollView: scrollView)
            }
            updateBracketHighlights(textView: textView, selection: selection)
        }

        private func updateCursorPosition(textView: STTextView, selection: NSRange) {
            let nsText = textView.attributedString().string as NSString
            let clampedLocation = min(max(0, selection.location), nsText.length)
            let lineRange = nsText.lineRange(for: NSRange(location: clampedLocation, length: 0))
            let prefix = nsText.substring(to: clampedLocation)
            let line = prefix.components(separatedBy: "\n").count
            let column = clampedLocation - lineRange.location + 1
            parent.onCursorMove(line, column)
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

struct ContentView: View {
    enum FocusedPane {
        case sidebar
        case editor
        case chat
        case terminal
        case diff
    }

    @ObservedObject var workspace: WorkspaceState
    @State private var focusedPane: FocusedPane? = .editor
    @State private var editorViewStates: [URL: EditorViewState] = [:]
    @State private var editorScrollMetrics = EditorScrollMetrics()

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
                                    pane(TerminalTabView(view: view), pane: .terminal)
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
                                    if let nvimView = workspace.nvimTerminalView {
                                        pane(TerminalTabView(view: nvimView), pane: .terminal)
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

    private var editorView: some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                CodeEditor(
                    text: $workspace.editorText,
                    selectionRequest: $workspace.pendingSelection,
                    scrollMetrics: $editorScrollMetrics,
                    language: workspace.currentLanguage,
                    fileURL: workspace.selectedFileURL,
                    theme: workspace.theme,
                    font: workspace.editorFont,
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
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                MinimapView(metrics: editorScrollMetrics, theme: workspace.theme)
                    .frame(width: 70)
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
                .font(.title3)
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
                .font(.title3)
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

    var body: some View {
        let theme = workspace.theme
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(spacing: 6) {
                    ForEach(workspace.openFiles, id: \.self) { url in
                        let isChat = workspace.isChatURL(url)
                        let isDiff = workspace.isDiffURL(url)
                        if workspace.isTerminalURL(url),
                           let view = workspace.terminalViews[url] {
                            TerminalTabBarItem(
                                view: view,
                                isSelected: url == workspace.selectedFileURL,
                                theme: theme,
                                onSelect: { workspace.selectFile(url) },
                                onClose: { workspace.requestCloseFile(url) }
                            )
                            .transition(.scale(scale: 0.8, anchor: .leading).combined(with: .opacity))
                        } else {
                            let diffInfo = isDiff ? workspace.diffTab(for: url) : nil
                            let diffSubtitle = diffInfo?.summary.isEmpty == false ? diffInfo?.summary : "Diff view"
                            let isModified = workspace.isFileModified(url)
                            TabBarItem(
                                title: isChat ? "Chat" : (diffInfo?.title ?? url.lastPathComponent),
                                subtitle: isChat ? "Current chat" : (diffSubtitle ?? workspace.displayPath(for: url)),
                                icon: isChat ? "bubble.left.and.bubble.right" : (isDiff ? "arrow.left.and.right" : iconForFile(url.lastPathComponent)),
                                isSelected: url == workspace.selectedFileURL,
                                isModified: isModified,
                                theme: theme,
                                onSelect: {
                                    workspace.selectFile(url)
                                },
                                onClose: {
                                    workspace.requestCloseFile(url)
                                }
                            )
                            .transition(.scale(scale: 0.8, anchor: .leading).combined(with: .opacity))
                        }
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

struct TabBarItem: View {
    let title: String
    let subtitle: String
    let icon: String
    let isSelected: Bool
    let isModified: Bool
    let theme: AppTheme
    let onSelect: () -> Void
    let onClose: () -> Void
    @State private var isHovered = false

    var body: some View {
        let helpText = isModified ? "\(subtitle)\nUnsaved changes" : subtitle
        let fileColor = colorForFile(title)
        let showClose = isModified ? isHovered : (isHovered || isSelected)
        let showDot = isModified && !isHovered
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: Typography.base))
                .foregroundStyle(fileColor?.opacity(0.8) ?? theme.mutedForegroundColor)
            Text(title)
                .font(.system(size: Typography.base, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(isSelected ? theme.tabSelectedForegroundColor : theme.tabForegroundColor)
            ZStack {
                if showDot {
                    let dotColor = isSelected ? theme.tabSelectedForegroundColor : theme.accentColor
                    Circle()
                        .fill(dotColor)
                        .frame(width: 6, height: 6)
                        .accessibilityLabel("Unsaved changes")
                        .transition(.opacity)
                }
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: Typography.xs, weight: .bold))
                        .foregroundStyle(theme.mutedForegroundColor)
                        .padding(4)
                }
                .buttonStyle(.plain)
                .opacity(showClose ? 1 : 0)
                .allowsHitTesting(showClose)
                .accessibilityLabel("Close \(title)")
            }
            .frame(width: 18, height: 16)
            .animation(.easeInOut(duration: 0.12), value: showClose)
            .animation(.easeInOut(duration: 0.12), value: showDot)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isSelected ? theme.tabSelectedBackgroundColor : (isHovered ? theme.tabSelectedBackgroundColor.opacity(0.5) : Color.clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(isSelected ? theme.tabBorderColor : theme.tabBorderColor.opacity(0.6))
        )
        .overlay(alignment: .bottom) {
            if isSelected {
                Rectangle()
                    .fill(theme.accentColor)
                    .frame(height: 2)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .onTapGesture(perform: onSelect)
        .onHover { isHovered = $0 }
        .help(helpText)
    }
}

func iconForFile(_ name: String) -> String {
    let ext = (name as NSString).pathExtension.lowercased()
    switch ext {
    case "swift": return "swift"
    case "py": return "text.page"
    case "js", "ts", "jsx", "tsx": return "curlybraces"
    case "json": return "curlybraces.square"
    case "md", "txt", "readme": return "doc.plaintext"
    case "yml", "yaml", "toml": return "gearshape"
    case "png", "jpg", "jpeg", "gif", "svg", "webp", "ico": return "photo"
    case "html", "css": return "globe"
    case "sh", "zsh", "bash": return "terminal"
    case "zip", "tar", "gz": return "doc.zipper"
    case "resolved": return "lock"
    default: return "doc.text"
    }
}

func colorForFile(_ name: String) -> Color? {
    let ext = (name as NSString).pathExtension.lowercased()
    switch ext {
    case "swift": return .orange
    case "py": return Color(red: 0.3, green: 0.6, blue: 0.9)
    case "js": return .yellow
    case "ts", "tsx": return Color(red: 0.2, green: 0.5, blue: 0.8)
    case "json": return .yellow.opacity(0.8)
    case "md": return Color(red: 0.5, green: 0.7, blue: 0.9)
    case "html": return .orange
    case "css": return Color(red: 0.3, green: 0.5, blue: 0.8)
    case "sh", "zsh", "bash": return .green
    default: return nil
    }
}
