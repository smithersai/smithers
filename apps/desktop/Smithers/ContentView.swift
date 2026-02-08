import SwiftUI
import Dispatch
import STTextView

struct CodeEditor: NSViewRepresentable {
    @Binding var text: String
    var language: SupportedLanguage?
    var fileURL: URL?

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = STTextView.scrollableTextView()
        let textView = scrollView.documentView as! STTextView

        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.backgroundColor = NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)
        textView.insertionPointColor = .white
        textView.highlightSelectedLine = true
        textView.selectedLineHighlightColor = NSColor(white: 0.18, alpha: 1)
        textView.widthTracksTextView = true
        textView.textColor = .white
        textView.delegate = context.coordinator
        let rulerView = STLineNumberRulerView(textView: textView)
        rulerView.backgroundColor = NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)
        rulerView.textColor = NSColor(white: 0.35, alpha: 1)
        rulerView.highlightSelectedLine = true
        rulerView.selectedLineTextColor = NSColor(white: 0.55, alpha: 1)
        rulerView.drawSeparator = false
        rulerView.rulerInsets = STRulerInsets(leading: 8, trailing: 8)
        scrollView.verticalRulerView = rulerView
        scrollView.rulersVisible = true

        scrollView.backgroundColor = NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)
        scrollView.scrollerStyle = .overlay
        scrollView.setAccessibilityIdentifier("CodeEditor")
        textView.setAccessibilityIdentifier("CodeEditorTextView")

        context.coordinator.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? STTextView else { return }
        let coord = context.coordinator

        if coord.currentFileURL != fileURL {
            coord.loadFile(text: text, language: language, fileURL: fileURL, textView: textView)
            return
        }

        if coord.lastAppliedText != text {
            coord.ignoreNextChange = true
            coord.setTextViewContent(textView, text: text)
            coord.scheduleHighlight(textView: textView, text: text, delay: 0)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    @MainActor class Coordinator: NSObject, STTextViewDelegate {
        var parent: CodeEditor
        var ignoreNextChange = false
        var highlighter: TreeSitterHighlighter?
        var currentFileURL: URL?
        private var highlighterCache: [String: TreeSitterHighlighter] = [:]
        private var highlightWorkItem: DispatchWorkItem?
        fileprivate var lastAppliedText: String = ""

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
                .foregroundColor: NSColor.white,
                .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            ]
            textView.setAttributedString(NSAttributedString(string: text, attributes: attrs))
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
                            DiffViewer(title: tab.title, summary: tab.summary, diff: tab.diff)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            emptyEditor
                        }
                    } else {
                        CodeEditor(text: $workspace.editorText, language: workspace.currentLanguage, fileURL: workspace.selectedFileURL)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                    emptyEditor
                }
            }
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if !workspace.openFiles.isEmpty {
                        TabBar(workspace: workspace)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }

            if workspace.isCommandPalettePresented {
                CommandPaletteView(workspace: workspace)
                    .transition(.opacity)
                    .zIndex(1)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: workspace.isCommandPalettePresented)
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
        .background(Color(nsColor: NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)))
    }
}

struct TabBar: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
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
                            onSelect: { workspace.selectFile(url) },
                            onClose: { workspace.closeFile(url) }
                        )
                    } else {
                        let diffInfo = isDiff ? workspace.diffTab(for: url) : nil
                        let diffSubtitle = diffInfo?.summary.isEmpty == false ? diffInfo?.summary : "Diff view"
                        TabBarItem(
                            title: isChat ? "Chat" : (diffInfo?.title ?? url.lastPathComponent),
                            subtitle: isChat ? "Current chat" : (diffSubtitle ?? workspace.displayPath(for: url)),
                            icon: isChat ? "bubble.left.and.bubble.right" : (isDiff ? "arrow.left.and.right" : iconForFile(url.lastPathComponent)),
                            isSelected: url == workspace.selectedFileURL,
                            onSelect: {
                                workspace.selectFile(url)
                            },
                            onClose: {
                                workspace.closeFile(url)
                            }
                        )
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("EditorTabBar")
    }
}

struct TabBarItem: View {
    let title: String
    let subtitle: String
    let icon: String
    let isSelected: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
                    .padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(title)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isSelected ? Color.white.opacity(0.10) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(Color.white.opacity(isSelected ? 0.12 : 0.05))
        )
        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .onTapGesture(perform: onSelect)
        .help(subtitle)
    }
}

private func iconForFile(_ name: String) -> String {
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
