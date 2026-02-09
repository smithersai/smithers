import SwiftUI
import Dispatch

struct ChatMessage: Identifiable, Hashable {
    enum Role: Hashable {
        case user
        case assistant
    }

    enum Kind: Hashable {
        case text(String)
        case command(CommandExecutionInfo)
        case status(String)
        case diffPreview(DiffPreview)
        case starterPrompt(title: String, suggestions: [String])
    }

    let id: UUID
    let role: Role
    var kind: Kind
    var isStreaming: Bool
    var turnId: String?

    init(role: Role, kind: Kind, isStreaming: Bool = false, turnId: String? = nil) {
        self.id = UUID()
        self.role = role
        self.kind = kind
        self.isStreaming = isStreaming
        self.turnId = turnId
    }

    var commandItemId: String? {
        guard case .command(let info) = kind else { return nil }
        return info.itemId
    }

    mutating func appendText(_ delta: String) {
        guard case .text(let text) = kind else { return }
        kind = .text(text + delta)
    }

    mutating func setText(_ text: String) {
        kind = .text(text)
    }

    mutating func appendCommandOutput(_ delta: String) {
        guard case .command(var info) = kind else { return }
        info.output += delta
        kind = .command(info)
    }

    mutating func completeCommand(exitCode: Int?) {
        guard case .command(var info) = kind else { return }
        info.exitCode = exitCode
        info.status = .completed
        kind = .command(info)
    }
}

struct DiffPreview: Identifiable, Hashable {
    let id: UUID
    let turnId: String?
    let files: [String]
    let summary: String
    let previewLines: [String]
    let diff: String
    let status: PatchApplyStatus

    var title: String {
        if files.isEmpty {
            return "File changes"
        }
        if files.count == 1 {
            return files[0]
        }
        return "\(files.count) files changed"
    }

    var filesText: String {
        if files.isEmpty {
            return "No files"
        }
        if files.count <= 2 {
            return files.joined(separator: ", ")
        }
        return "\(files[0]), \(files[1]) +\(files.count - 2) more"
    }

    static func fromFileChange(turnId: String?, item: FileChangeItem) -> DiffPreview {
        let diff = item.changes.map(\.diff).joined(separator: "\n")
        let files = DiffPreview.uniquePaths(item.changes.map(\.path))
        let (added, removed) = DiffPreview.countLineChanges(diff)
        let summary = "+\(added) -\(removed)"
        let previewLines = DiffPreview.makePreviewLines(diff, maxLines: 8)
        return DiffPreview(
            id: UUID(),
            turnId: turnId,
            files: files,
            summary: summary,
            previewLines: previewLines,
            diff: diff,
            status: item.status
        )
    }

    static func fromTurnDiff(turnId: String, diff: String) -> DiffPreview {
        let summary = DiffPreview.summarize(diff: diff)
        let previewLines = DiffPreview.makePreviewLines(diff, maxLines: 8)
        return DiffPreview(
            id: UUID(),
            turnId: turnId,
            files: summary.files,
            summary: summary.summary,
            previewLines: previewLines,
            diff: diff,
            status: .completed
        )
    }

    static func fromStreamingDiff(turnId: String, diff: String) -> DiffPreview {
        let summary = DiffPreview.summarize(diff: diff)
        let previewLines = DiffPreview.makePreviewLines(diff, maxLines: 8)
        return DiffPreview(
            id: UUID(),
            turnId: turnId,
            files: summary.files,
            summary: summary.summary,
            previewLines: previewLines,
            diff: diff,
            status: .inProgress
        )
    }

    static func summarize(diff: String) -> (files: [String], summary: String) {
        let files = DiffPreview.uniquePaths(DiffPreview.parsePathsFromUnifiedDiff(diff))
        let (added, removed) = DiffPreview.countLineChanges(diff)
        let summary = "+\(added) -\(removed)"
        return (files, summary)
    }

    private static func countLineChanges(_ diff: String) -> (added: Int, removed: Int) {
        var added = 0
        var removed = 0
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+") && !line.hasPrefix("+++") {
                added += 1
            } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                removed += 1
            }
        }
        return (added, removed)
    }

    private static func uniquePaths(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        ordered.reserveCapacity(paths.count)
        for path in paths {
            if seen.insert(path).inserted {
                ordered.append(path)
            }
        }
        return ordered
    }

    private static func parsePathsFromUnifiedDiff(_ diff: String) -> [String] {
        var paths: [String] = []
        for rawLine in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            guard rawLine.hasPrefix("diff --git ") else { continue }
            let rest = rawLine.dropFirst("diff --git ".count)
            let tokens = readDiffTokens(String(rest), maxTokens: 2)
            guard tokens.count >= 2 else { continue }
            if let path = normalizeDiffPath(tokens[1]) {
                paths.append(path)
            }
        }
        return paths
    }

    private static func readDiffTokens(_ line: String, maxTokens: Int) -> [String] {
        var tokens: [String] = []
        var current = ""
        var isQuoted = false
        var escapeNext = false

        for ch in line {
            if escapeNext {
                current.append(ch)
                escapeNext = false
                continue
            }
            if ch == "\\" {
                escapeNext = true
                continue
            }
            if ch == "\"" {
                isQuoted.toggle()
                continue
            }
            if ch == " " && !isQuoted {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                    if tokens.count == maxTokens {
                        break
                    }
                }
                continue
            }
            current.append(ch)
        }

        if !current.isEmpty && tokens.count < maxTokens {
            tokens.append(current)
        }

        return tokens
    }

    private static func normalizeDiffPath(_ token: String) -> String? {
        let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        if trimmed.hasPrefix("b/") {
            return String(trimmed.dropFirst(2))
        }
        if trimmed.hasPrefix("a/") {
            return String(trimmed.dropFirst(2))
        }
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func makePreviewLines(_ diff: String, maxLines: Int) -> [String] {
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.isEmpty {
            return ["(No diff available)"]
        }
        return Array(lines.prefix(maxLines))
    }
}

struct CommandExecutionInfo: Hashable {
    let itemId: String
    var command: String
    var cwd: String
    var output: String
    var exitCode: Int?
    var status: CommandExecutionStatus
}

struct SessionDiffSnapshot: Identifiable, Hashable {
    let id: String = "session-diff"
    let files: [String]
    let summary: String
    let diff: String

    var title: String {
        "Session Diff"
    }
}

enum CommandExecutionStatus: Hashable {
    case running
    case completed
}

struct ChatView: View {
    @ObservedObject var workspace: WorkspaceState
    @FocusState private var inputFocused: Bool

    var body: some View {
        let theme = workspace.theme
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(workspace.chatMessages) { message in
                            ChatBubble(message: message, workspace: workspace)
                                .id(message.id)
                                .transition(.asymmetric(
                                    insertion: .move(edge: message.role == .user ? .trailing : .leading)
                                        .combined(with: .opacity),
                                    removal: .opacity
                                ))
                        }
                        if workspace.isTurnInProgress {
                            ThinkingRow()
                        }
                    }
                    .animation(.spring(duration: 0.3, bounce: 0.1), value: workspace.chatMessages.count)
                    .padding(16)
                }
                .background(theme.backgroundColor)
                .onChange(of: workspace.chatMessages) { _, messages in
                    guard let last = messages.last else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            Divider()
                .background(theme.dividerColor)

            HStack(spacing: 8) {
                TextField("Message...", text: $workspace.chatDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(theme.inputFieldBackgroundColor)
                    )
                    .focused($inputFocused)
                    .onSubmit {
                        workspace.sendChatMessage()
                    }

                if workspace.isTurnInProgress {
                    Button("Interrupt") {
                        workspace.interruptTurn()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }

                if workspace.sessionDiffSnapshot != nil {
                    Button("Session Diff") {
                        workspace.presentSessionDiff()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }

                Button("New Chat") {
                    workspace.startNewChat()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(workspace.isTurnInProgress)

                Button("Send") {
                    workspace.sendChatMessage()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(12)
            .background(theme.secondaryBackgroundColor)
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                inputFocused = true
            }
        }
        .sheet(item: $workspace.activeDiffPreview) { preview in
            DiffViewer(
                title: preview.title,
                summary: preview.summary,
                diff: preview.diff,
                theme: workspace.theme,
                onOpenInTab: {
                    workspace.openDiffTab(title: preview.title, summary: preview.summary, diff: preview.diff)
                    workspace.activeDiffPreview = nil
                }
            )
        }
        .sheet(item: $workspace.activeSessionDiff) { snapshot in
            DiffViewer(
                title: snapshot.title,
                summary: snapshot.summary,
                diff: snapshot.diff,
                theme: workspace.theme,
                onOpenInTab: {
                    workspace.openDiffTab(title: snapshot.title, summary: snapshot.summary, diff: snapshot.diff)
                    workspace.activeSessionDiff = nil
                }
            )
        }
    }
}

struct ChatBubble: View {
    let message: ChatMessage
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        HStack {
            if message.role == .assistant {
                bubble
                Spacer(minLength: 24)
            } else {
                Spacer(minLength: 24)
                bubble
            }
        }
    }

    private var bubble: some View {
        bubbleContent
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(bubbleColor)
            )
    }

    private var bubbleColor: Color {
        let theme = workspace.theme
        switch message.kind {
        case .command:
            return theme.chatCommandBubbleColor
        case .status:
            return theme.chatStatusBubbleColor
        case .diffPreview:
            return theme.chatDiffBubbleColor
        case .starterPrompt:
            return theme.chatAssistantBubbleColor
        case .text:
            switch message.role {
            case .assistant:
                return theme.chatAssistantBubbleColor
            case .user:
                return theme.chatUserBubbleColor
            }
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        switch message.kind {
        case .text(let text):
            LinkifiedText(
                workspace: workspace,
                text: message.isStreaming ? text + " ..." : text,
                font: .system(size: 13, weight: .regular),
                baseColor: .primary,
                selectionEnabled: true
            )
        case .status(let text):
            LinkifiedText(
                workspace: workspace,
                text: text,
                font: .system(size: 12, weight: .regular),
                baseColor: .secondary,
                selectionEnabled: true
            )
        case .command(let info):
            VStack(alignment: .leading, spacing: 6) {
                LinkifiedText(
                    workspace: workspace,
                    text: "$ \(info.command)",
                    font: .system(size: 12, weight: .medium, design: .monospaced),
                    baseColor: .primary,
                    selectionEnabled: true
                )
                if !info.cwd.isEmpty {
                    LinkifiedText(
                        workspace: workspace,
                        text: "cwd: \(info.cwd)",
                        font: .system(size: 11),
                        baseColor: .secondary,
                        selectionEnabled: true
                    )
                }
                if !info.output.isEmpty {
                    LinkifiedText(
                        workspace: workspace,
                        text: info.output,
                        font: .system(size: 12, weight: .regular, design: .monospaced),
                        baseColor: .primary,
                        selectionEnabled: true
                    )
                }
                if let exitCode = info.exitCode {
                    Text("exit \(exitCode)")
                        .font(.system(size: 11))
                        .foregroundStyle(exitCode == 0 ? .green : .red)
                } else if info.status == .running {
                    Text("running")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        case .diffPreview(let preview):
            DiffPreviewCard(preview: preview) {
                workspace.presentDiff(preview)
            }
        case .starterPrompt(let title, let suggestions):
            StarterPromptView(title: title, suggestions: suggestions, workspace: workspace)
        }
    }
}

struct StarterPromptView: View {
    let title: String
    let suggestions: [String]
    @ObservedObject var workspace: WorkspaceState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
            ForEach(suggestions, id: \.self) { suggestion in
                Button {
                    guard !workspace.isTurnInProgress else { return }
                    workspace.sendChatMessage(text: suggestion)
                } label: {
                    Text(suggestion)
                        .font(.system(size: 12))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(workspace.isTurnInProgress)
            }
        }
    }
}

struct DiffPreviewCard: View {
    let preview: DiffPreview
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(preview.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    DiffStatusBadge(status: preview.status)
                }
                Text(preview.filesText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(preview.summary)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                DiffSnippetView(lines: preview.previewLines)
                Text("Click to view full diff")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
}

struct DiffSnippetView: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                DiffLineRow(line: line, fontSize: 11)
            }
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.black.opacity(0.2))
        )
    }
}

struct DiffLineRow: View {
    let line: String
    let fontSize: CGFloat
    let allowWrapping: Bool

    init(line: String, fontSize: CGFloat, allowWrapping: Bool = true) {
        self.line = line
        self.fontSize = fontSize
        self.allowWrapping = allowWrapping
    }

    var body: some View {
        let text = Text(line.isEmpty ? " " : line)
            .font(.system(size: fontSize, weight: .regular, design: .monospaced))
            .foregroundStyle(colorForLine(line))
            .frame(maxWidth: .infinity, alignment: .leading)

        if allowWrapping {
            text
        } else {
            text.fixedSize(horizontal: true, vertical: false)
        }
    }

    private func colorForLine(_ line: String) -> Color {
        if line.hasPrefix("+++ ") || line.hasPrefix("--- ") {
            return Color.secondary
        }
        if line.hasPrefix("+") {
            return Color.green.opacity(0.9)
        }
        if line.hasPrefix("-") {
            return Color.red.opacity(0.9)
        }
        if line.hasPrefix("@@") {
            return Color.purple.opacity(0.9)
        }
        if line.hasPrefix("diff --git") || line.hasPrefix("index ") {
            return Color.secondary
        }
        return Color.primary
    }
}

struct DiffStatusBadge: View {
    let status: PatchApplyStatus

    var body: some View {
        Text(statusText)
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                Capsule(style: .continuous)
                    .fill(statusColor.opacity(0.2))
            )
            .foregroundStyle(statusColor)
    }

    private var statusText: String {
        switch status {
        case .completed:
            return "Applied"
        case .failed:
            return "Failed"
        case .declined:
            return "Declined"
        case .inProgress:
            return "Applying"
        }
    }

    private var statusColor: Color {
        switch status {
        case .completed:
            return Color.green
        case .failed:
            return Color.red
        case .declined:
            return Color.orange
        case .inProgress:
            return Color.blue
        }
    }
}

struct ThinkingRow: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Thinking...")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 4)
    }
}
