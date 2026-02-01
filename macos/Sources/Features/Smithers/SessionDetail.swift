import SwiftUI

/// View mode for the session detail
enum SessionViewMode {
    case chat
    case graph
}

/// The main content area showing the selected session's terminal
struct SessionDetail: View {
    let session: Session?
    @State private var messageInput: String = ""
    @StateObject private var terminalManager = TerminalSessionManager()
    @State private var isTerminalDrawerOpen = false
    @State private var viewMode: SessionViewMode = .chat
    @State private var selectedNodeId: UUID?
    @State private var selectedInspectorTab: InspectorTab = .stack
    @State private var inspectorVisible: Bool = true
    @State private var showSkillsPalette = false
    @EnvironmentObject var ghostty: Ghostty.App

    var body: some View {
        if let session = session {
            HSplitView {
                // Main content area
                VStack(spacing: 0) {
                    // Header
                    sessionHeader(session)

                    Divider()

                    // Main content area - switch between chat and graph views
                    contentArea(session)

                    // Input bar at bottom
                    inputBar

                    // Terminal drawer at the bottom
                    Divider()
                    TerminalDrawerView(
                        manager: terminalManager,
                        isOpen: $isTerminalDrawerOpen
                    )
                    .environmentObject(ghostty)
                }
                .frame(minWidth: 500)

                // Inspector panel (right side)
                if inspectorVisible {
                    SessionInspectorView(
                        selectedTab: $selectedInspectorTab,
                        selectedNodeId: $selectedNodeId
                    )
                }
            }
            .sheet(isPresented: $showSkillsPalette) {
                SkillsPalette(
                    isPresented: $showSkillsPalette,
                    sessionId: session.id.uuidString,
                    onSelectSkill: { skill, args in
                        runSkill(skill: skill, args: args)
                    }
                )
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
                // View mode picker
                Picker("View Mode", selection: $viewMode) {
                    Text("Chat").tag(SessionViewMode.chat)
                    Text("Graph").tag(SessionViewMode.graph)
                }
                .pickerStyle(.segmented)
                .frame(width: 150)

                Spacer()
                    .frame(width: 20)

                Button(action: { showSkillsPalette = true }) {
                    Image(systemName: "command")
                }
                .buttonStyle(.plain)
                .help("Skills (⌘K)")

                Button(action: openTerminal) {
                    Image(systemName: "terminal")
                }
                .buttonStyle(.plain)
                .help("Open Terminal")

                Button(action: { inspectorVisible.toggle() }) {
                    Image(systemName: inspectorVisible ? "sidebar.right" : "sidebar.right")
                }
                .buttonStyle(.plain)
                .foregroundColor(inspectorVisible ? .accentColor : .secondary)
                .help(inspectorVisible ? "Hide Inspector" : "Show Inspector")

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

    private func contentArea(_ session: Session) -> some View {
        Group {
            switch viewMode {
            case .chat:
                chatArea(session)
            case .graph:
                graphArea(session)
            }
        }
        .onChange(of: selectedNodeId) { newValue in
            // When a node is selected in the graph, sync it to other views
            if let nodeId = newValue {
                handleNodeSelection(nodeId)
            }
        }
    }

    private func chatArea(_ session: Session) -> some View {
        ZStack {
            Color(nsColor: .textBackgroundColor)

            // Render chat messages from the session graph
            MessageList(items: session.graph.projectToChat())
        }
    }

    private func graphArea(_ session: Session) -> some View {
        ZStack {
            Color(nsColor: .textBackgroundColor)

            // Render the session graph
            GraphView(graph: session.graph, selectedNodeId: $selectedNodeId)
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

    private func openTerminal() {
        // Open the drawer
        isTerminalDrawerOpen = true

        // Open a new terminal tab or reuse existing
        // TODO: Get the actual working directory from the session
        let cwd = FileManager.default.homeDirectoryForCurrentUser
        let tabId = terminalManager.reuseOrOpenTab(cwd: cwd, title: "Terminal")

        // Create the surface if needed
        if let tab = terminalManager.selectedTab, tab.surfaceView == nil {
            terminalManager.createSurface(for: tabId, ghosttyApp: ghostty)
        }
    }

    private func handleNodeSelection(_ nodeId: UUID) {
        // When a node is selected in the graph view:
        // 1. Scroll the chat view to show the corresponding message
        // TODO: Implement chat scroll sync

        // 2. Update the inspector panel to show node details
        // Make inspector visible and switch to Tools or Run Details tab
        if !inspectorVisible {
            inspectorVisible = true
        }
        // Switch to Tools tab to show the selected node details
        selectedInspectorTab = .tools

        // 3. If it's a tool invocation, optionally open the terminal to the correct CWD
        // TODO: Check if node is a tool invocation and open terminal
        print("Node selected: \(nodeId)")
    }

    private func runSkill(skill: Skill, args: String?) {
        guard let session = session else { return }
        // TODO: Send skill.run request to agentd via AgentClient
        // For now, just log it
        print("Running skill: \(skill.name) (id: \(skill.id)) for session \(session.id)")
        if let args = args {
            print("  Args: \(args)")
        }
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
