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
    }

    let id: UUID
    let role: Role
    var kind: Kind
    var isStreaming: Bool

    init(role: Role, kind: Kind, isStreaming: Bool = false) {
        self.id = UUID()
        self.role = role
        self.kind = kind
        self.isStreaming = isStreaming
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

struct CommandExecutionInfo: Hashable {
    let itemId: String
    var command: String
    var cwd: String
    var output: String
    var exitCode: Int?
    var status: CommandExecutionStatus
}

enum CommandExecutionStatus: Hashable {
    case running
    case completed
}

struct ChatView: View {
    @ObservedObject var workspace: WorkspaceState
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(workspace.chatMessages) { message in
                            ChatBubble(message: message)
                                .id(message.id)
                        }
                        if workspace.isTurnInProgress {
                            ThinkingRow()
                        }
                    }
                    .padding(16)
                }
                .background(Color(nsColor: NSColor(red: 0.11, green: 0.12, blue: 0.14, alpha: 1)))
                .onChange(of: workspace.chatMessages) { _, messages in
                    guard let last = messages.last else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            Divider()

            HStack(spacing: 8) {
                TextField("Message...", text: $workspace.chatDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.06))
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

                Button("Send") {
                    workspace.sendChatMessage()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(12)
            .background(Color(nsColor: NSColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 1)))
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                inputFocused = true
            }
        }
    }
}

struct ChatBubble: View {
    let message: ChatMessage

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
        switch message.kind {
        case .command:
            return Color.black.opacity(0.35)
        case .status:
            return Color.white.opacity(0.05)
        case .text:
            switch message.role {
            case .assistant:
                return Color.white.opacity(0.08)
            case .user:
                return Color.blue.opacity(0.35)
            }
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        switch message.kind {
        case .text(let text):
            Text(message.isStreaming ? text + " ..." : text)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.primary)
        case .status(let text):
            Text(text)
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(.secondary)
        case .command(let info):
            VStack(alignment: .leading, spacing: 6) {
                Text("$ \(info.command)")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary)
                if !info.cwd.isEmpty {
                    Text("cwd: \(info.cwd)")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                if !info.output.isEmpty {
                    Text(info.output)
                        .font(.system(size: 12, weight: .regular, design: .monospaced))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
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
