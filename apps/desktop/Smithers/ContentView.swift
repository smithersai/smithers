import SwiftUI
import Dispatch
import STTextView

struct CodeEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var selectionRequest: EditorSelection?
    var language: SupportedLanguage?
    var fileURL: URL?
    var theme: AppTheme

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = STTextView.scrollableTextView()
        let textView = scrollView.documentView as! STTextView

        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.backgroundColor = theme.background
        textView.insertionPointColor = theme.foreground
        textView.highlightSelectedLine = true
        textView.selectedLineHighlightColor = theme.lineHighlight
        textView.widthTracksTextView = true
        textView.textColor = theme.foreground
        textView.delegate = context.coordinator
        let rulerView = STLineNumberRulerView(textView: textView)
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
        scrollView.setAccessibilityIdentifier("CodeEditor")
        textView.setAccessibilityIdentifier("CodeEditorTextView")

        context.coordinator.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
        context.coordinator.appliedTheme = theme

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
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            return
        }

        if coord.lastAppliedText != text {
            coord.ignoreNextChange = true
            coord.setTextViewContent(textView, text: text)
            coord.scheduleHighlight(textView: textView, text: text, delay: 0)
        }

        applySelectionRequest(textView: textView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    private func applySelectionRequest(textView: STTextView) {
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
        if let range = rangeForLineColumn(text: currentText, line: selection.line, column: selection.column) {
            textView.setSelectedRange(range)
            textView.scrollRangeToVisible(range)
        }
        DispatchQueue.main.async {
            selectionRequest = nil
        }
    }

    private func rangeForLineColumn(text: String, line: Int, column: Int) -> NSRange? {
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
        return NSRange(location: target, length: 0)
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
        private var highlighterCache: [String: TreeSitterHighlighter] = [:]
        private var highlightWorkItem: DispatchWorkItem?
        fileprivate var lastAppliedText: String = ""
        var appliedTheme: AppTheme?

        init(parent: CodeEditor) {
            self.parent = parent
        }

        func loadFile(text: String, language: SupportedLanguage?, fileURL: URL?, textView: STTextView) {
            currentFileURL = fileURL
            ignoreNextChange = true
            setTextViewContent(textView, text: text)

            if let language {
                if let cached = highlighterCache[language.name] {
                    highlighter = cached
                } else {
                    let h = TreeSitterHighlighter(language: language)
                    highlighterCache[language.name] = h
                    highlighter = h
                }
                scheduleHighlight(textView: textView, text: text, delay: 0)
            } else {
                highlighter = nil
            }
        }

        func setTextViewContent(_ textView: STTextView, text: String) {
            let attrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: parent.theme.foreground,
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            ]
            textView.setAttributedString(NSAttributedString(string: text, attributes: attrs))
            textView.typingAttributes = attrs
            lastAppliedText = text
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
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        ZStack {
            NavigationSplitView {
                FileTreeSidebar(workspace: workspace)
                    .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 400)
            } detail: {
                VStack(spacing: 0) {
                    if !workspace.openFiles.isEmpty {
                        TabBar(workspace: workspace)
                        Divider()
                            .background(workspace.theme.dividerColor)
                    }
                    if let selectedURL = workspace.selectedFileURL {
                        if workspace.isChatURL(selectedURL) {
                            ChatView(workspace: workspace)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else if workspace.isTerminalURL(selectedURL) {
                            if let view = workspace.terminalViews[selectedURL] {
                                TerminalTabView(view: view)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                            } else {
                                emptyEditor
                            }
                        } else if workspace.isDiffURL(selectedURL) {
                            if let tab = workspace.diffTab(for: selectedURL) {
                                DiffViewer(title: tab.title, summary: tab.summary, diff: tab.diff, theme: workspace.theme)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                            } else {
                                emptyEditor
                            }
                        } else {
                            if workspace.isNvimModeEnabled {
                                if let nvimView = workspace.nvimTerminalView {
                                    TerminalTabView(view: nvimView)
                                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                                } else {
                                    nvimPlaceholder
                                }
                            } else {
                                CodeEditor(
                                    text: $workspace.editorText,
                                    selectionRequest: $workspace.pendingSelection,
                                    language: workspace.currentLanguage,
                                    fileURL: workspace.selectedFileURL,
                                    theme: workspace.theme
                                )
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                } else {
                    emptyEditor
                }
            }
            }
            .navigationTitle("")

            if workspace.isCommandPalettePresented {
                CommandPaletteView(workspace: workspace)
                    .transition(.opacity)
                    .zIndex(1)
            }

            if let toast = workspace.toastMessage {
                VStack {
                    Spacer()
                    ToastView(message: toast, theme: workspace.theme)
                        .padding(.bottom, 24)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .allowsHitTesting(false)
                .zIndex(2)
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
        .animation(.easeInOut(duration: 0.15), value: workspace.isCommandPalettePresented)
        .animation(.easeInOut(duration: 0.2), value: workspace.toastMessage)
        .background(workspace.theme.backgroundColor)
    }

    private var emptyEditor: some View {
        VStack(spacing: 8) {
            Image(systemName: "doc.text")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Select a file to edit")
                .font(.title3)
                .foregroundStyle(.secondary)
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
}

private struct ToastView: View {
    let message: String
    let theme: AppTheme

    var body: some View {
        Text(message)
            .font(.system(size: 12, weight: .semibold))
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
            ScrollView(.horizontal, showsIndicators: false) {
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
                        }
                    }
                }
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
                    .font(.system(size: 13, weight: .medium))
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

    var body: some View {
        let helpText = isModified ? "\(subtitle)\nUnsaved changes" : subtitle
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(theme.mutedForegroundColor)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(isSelected ? theme.tabSelectedForegroundColor : theme.tabForegroundColor)
            if isModified {
                let dotColor = isSelected ? theme.tabSelectedForegroundColor : theme.accentColor
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)
                    .accessibilityLabel("Unsaved changes")
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(theme.mutedForegroundColor)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(title)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isSelected ? theme.tabSelectedBackgroundColor : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(isSelected ? theme.tabBorderColor : theme.tabBorderColor.opacity(0.6))
        )
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .onTapGesture(perform: onSelect)
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
