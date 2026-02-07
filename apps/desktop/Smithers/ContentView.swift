import SwiftUI
import STTextView

struct CodeEditor: NSViewRepresentable {
    @Binding var text: String

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

        setTextViewContent(textView, text: text)

        scrollView.backgroundColor = NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)
        scrollView.scrollerStyle = .overlay
        scrollView.setAccessibilityIdentifier("CodeEditor")
        textView.setAccessibilityIdentifier("CodeEditorTextView")

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? STTextView else { return }
        let current = textView.attributedString().string
        if current != text {
            context.coordinator.ignoreNextChange = true
            setTextViewContent(textView, text: text)
        }
    }

    private func setTextViewContent(_ textView: STTextView, text: String) {
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.white,
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
        ]
        textView.setAttributedString(NSAttributedString(string: text, attributes: attrs))
        let fullRange = NSRange(location: 0, length: (text as NSString).length)
        textView.setTextColor(.white, range: fullRange)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    class Coordinator: NSObject, STTextViewDelegate {
        var parent: CodeEditor
        var ignoreNextChange = false

        init(parent: CodeEditor) {
            self.parent = parent
        }

        func textViewDidChangeText(_ notification: Notification) {
            if ignoreNextChange {
                ignoreNextChange = false
                return
            }
            guard let textView = notification.object as? STTextView else { return }
            parent.text = textView.attributedString().string
        }
    }
}

struct ContentView: View {
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        NavigationSplitView {
            FileTreeSidebar(workspace: workspace)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 400)
        } detail: {
            if workspace.selectedFileURL != nil {
                CodeEditor(text: $workspace.editorText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                emptyEditor
            }
        }
        .navigationTitle(workspace.rootDirectory?.lastPathComponent ?? "Smithers")
        .toolbar {
            ToolbarItem(placement: .automatic) {
                if let fileName = workspace.selectedFileURL?.lastPathComponent {
                    Text(fileName)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
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
