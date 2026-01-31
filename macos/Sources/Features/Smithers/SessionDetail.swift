import SwiftUI

/// The main content area showing the selected session's terminal
struct SessionDetail: View {
    let session: Session?
    @State private var messageInput: String = ""

    var body: some View {
        if let session = session {
            VStack(spacing: 0) {
                // Header
                sessionHeader(session)

                Divider()

                // Chat area with messages
                chatArea(session)

                // Input bar at bottom
                inputBar
            }
        } else {
            emptyState
        }
    }

    // MARK: - Subviews

    private func sessionHeader(_ session: Session) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.headline)

                HStack(spacing: 4) {
                    Circle()
                        .fill(session.isActive ? Color.green : Color.secondary)
                        .frame(width: 6, height: 6)
                    Text(session.isActive ? "Running" : "Idle")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // Action buttons
            HStack(spacing: 12) {
                Button(action: {}) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Restart session")

                Button(action: {}) {
                    Image(systemName: "square.and.arrow.up")
                }
                .buttonStyle(.plain)
                .help("Share session")

                Button(action: {}) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .foregroundColor(.red.opacity(0.8))
                .help("Delete session")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func chatArea(_ session: Session) -> some View {
        ZStack {
            Color(nsColor: .textBackgroundColor)

            // Render chat messages from the session graph
            MessageList(messages: session.graph.projectToChat())
        }
    }

    private var inputBar: some View {
        HStack(spacing: 12) {
            Image(systemName: "terminal")
                .foregroundColor(.secondary)

            TextField("Type a message or command...", text: $messageInput)
                .textFieldStyle(.plain)
                .onSubmit {
                    sendMessage()
                }

            Button(action: sendMessage) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 24))
            }
            .buttonStyle(.plain)
            .foregroundColor(messageInput.isEmpty ? .secondary : .accentColor)
            .disabled(messageInput.isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Actions

    private func sendMessage() {
        guard !messageInput.isEmpty else { return }
        // TODO: Send message to agent daemon
        print("Sending message: \(messageInput)")
        messageInput = ""
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 48))
                .foregroundColor(.secondary)

            Text("No session selected")
                .font(.headline)
                .foregroundColor(.secondary)

            Text("Select a session from the sidebar or create a new one")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }
}

#Preview("With Session") {
    SessionDetail(session: Session.mockSessions.first)
        .frame(width: 600, height: 500)
}

#Preview("Empty State") {
    SessionDetail(session: nil)
        .frame(width: 600, height: 500)
}
