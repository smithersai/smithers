import SwiftUI

/// A scrollable list of chat messages with auto-scroll behavior
struct MessageList: View {
    let messages: [ChatMessage]
    @State private var isAtBottom = true
    @State private var scrollProxy: ScrollViewProxy?

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(messages) { message in
                            MessageRow(message: message)
                                .id(message.id)
                        }

                        // Invisible anchor at the bottom
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                }
                .onAppear {
                    scrollProxy = proxy
                    scrollToBottom(animated: false)
                }
                .onChange(of: messages.count) { _ in
                    if isAtBottom {
                        scrollToBottom(animated: true)
                    }
                }
            }

            // "Jump to latest" button (shown when not at bottom)
            if !isAtBottom && messages.count > 0 {
                jumpToBottomButton
                    .padding(.bottom, 16)
            }
        }
    }

    // MARK: - Subviews

    private var jumpToBottomButton: some View {
        Button(action: {
            scrollToBottom(animated: true)
        }) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .medium))
                Text("Jump to latest")
                    .font(.system(size: 13, weight: .medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(Color.accentColor)
            )
            .foregroundColor(.white)
        }
        .buttonStyle(.plain)
        .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }

    // MARK: - Helpers

    private func scrollToBottom(animated: Bool) {
        guard let proxy = scrollProxy else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
        isAtBottom = true
    }
}

#Preview("Empty") {
    MessageList(messages: [])
        .frame(width: 600, height: 400)
}

#Preview("Few Messages") {
    MessageList(messages: [
        ChatMessage(
            id: UUID(),
            role: .user,
            content: "Help me fix the authentication bug",
            timestamp: Date().addingTimeInterval(-120)
        ),
        ChatMessage(
            id: UUID(),
            role: .assistant,
            content: "I'll help you with that. Let me read the authentication file first.",
            timestamp: Date().addingTimeInterval(-60)
        ),
        ChatMessage(
            id: UUID(),
            role: .assistant,
            content: "I found the issue. The token validation is missing expiration checks. Let me fix that now.",
            timestamp: Date()
        ),
    ])
    .frame(width: 600, height: 400)
}

#Preview("Many Messages") {
    MessageList(messages: (0..<20).map { i in
        ChatMessage(
            id: UUID(),
            role: i % 3 == 0 ? .user : .assistant,
            content: i % 3 == 0
                ? "User message \(i / 3 + 1): Can you help with this task?"
                : "Assistant response \(i): I'm analyzing the request and will help you shortly. This might take a moment while I read the relevant files.",
            timestamp: Date().addingTimeInterval(Double(-600 + i * 30))
        )
    })
    .frame(width: 600, height: 400)
}
