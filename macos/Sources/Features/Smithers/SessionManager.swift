import Foundation
import Combine

/// Manages sessions and orchestrates communication with agentd
@MainActor
class SessionManager: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var error: String?

    private var agentClient: AgentClient?
    private var cancellables = Set<AnyCancellable>()
    private let workspaceRoot: String
    private let sandboxMode: String
    private let agentBackend: String

    /// The workspace root directory for this session manager
    var workspace: String {
        workspaceRoot
    }

    init(
        workspaceRoot: String,
        sandboxMode: String = "host",
        agentBackend: String = "fake"
    ) {
        self.workspaceRoot = workspaceRoot
        self.sandboxMode = sandboxMode
        self.agentBackend = agentBackend
    }

    /// Start the agent daemon and load existing sessions
    func start() async throws {
        let client = AgentClient(
            workspaceRoot: workspaceRoot,
            sandboxMode: sandboxMode,
            agentBackend: agentBackend
        )

        // Subscribe to events before starting
        client.events
            .sink { [weak self] event in
                Task { @MainActor in
                    self?.handleEvent(event)
                }
            }
            .store(in: &cancellables)

        try await client.start()
        self.agentClient = client

        // Request list of existing sessions
        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "session.list",
            params: ["limit": 100]
        ))
    }

    /// Stop the agent daemon
    func stop() {
        agentClient?.stop()
        agentClient = nil
        cancellables.removeAll()
    }

    /// Create a new session
    func createSession() throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "session.create",
            params: ["workspace_root": workspaceRoot]
        ))
    }

    /// Send a message to a session
    func sendMessage(sessionId: UUID, message: String, surfaces: [String] = []) throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "session.send",
            params: [
                "session_id": sessionId.uuidString,
                "message": message,
                "surfaces": surfaces
            ]
        ))
    }

    /// Cancel a running agent
    func cancelRun(runId: String) throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "run.cancel",
            params: ["run_id": runId]
        ))
    }

    /// Run a skill in a session
    func runSkill(sessionId: UUID, skillId: String, args: String? = nil) throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        var params: [String: Any] = [
            "session_id": sessionId.uuidString,
            "skill_id": skillId
        ]
        if let args = args {
            params["args"] = args
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "skill.run",
            params: params
        ))
    }

    /// Create a checkpoint
    func createCheckpoint(sessionId: UUID, message: String, sessionNodeId: String? = nil) throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        var params: [String: Any] = [
            "session_id": sessionId.uuidString,
            "message": message
        ]
        if let nodeId = sessionNodeId {
            params["session_node_id"] = nodeId
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "checkpoint.create",
            params: params
        ))
    }

    /// Restore a checkpoint
    func restoreCheckpoint(sessionId: UUID, checkpointId: String) throws {
        guard let client = agentClient else {
            throw SessionManagerError.notConnected
        }

        try client.send(AgentRequest(
            id: UUID().uuidString,
            method: "checkpoint.restore",
            params: [
                "session_id": sessionId.uuidString,
                "checkpoint_id": checkpointId
            ]
        ))
    }

    // MARK: - Event Handling

    private func handleEvent(_ event: AgentEvent) {
        switch event.type {
        case .daemonReady:
            // Daemon is ready, sessions will be loaded via session.list response
            print("Daemon ready: \(event.data)")

        case .sessionCreated:
            // New session created
            if let sessionIdStr = event.data["session_id"] as? String,
               let sessionId = UUID(uuidString: sessionIdStr) {
                let session = Session(
                    id: sessionId,
                    title: "New Session",
                    createdAt: Date(),
                    isActive: false
                )
                sessions.append(session)
            }

        case .sessionList:
            // Load sessions from list
            if let sessionList = event.data["sessions"] as? [[String: Any]] {
                sessions = sessionList.compactMap { data in
                    guard let idStr = data["id"] as? String,
                          let id = UUID(uuidString: idStr),
                          let createdAtStr = data["created_at"] as? String,
                          let createdAt = ISO8601DateFormatter().date(from: createdAtStr) else {
                        return nil
                    }

                    // TODO: Load graph from events
                    return Session(
                        id: id,
                        title: "Session \(id.uuidString.prefix(8))",
                        createdAt: createdAt,
                        isActive: false
                    )
                }
            }

        case .runStarted:
            // Mark session as active
            if let sessionIdStr = event.data["session_id"] as? String,
               let sessionId = UUID(uuidString: sessionIdStr),
               let index = sessions.firstIndex(where: { $0.id == sessionId }) {
                sessions[index].isActive = true
            }

        case .runFinished, .runCancelled:
            // Mark session as inactive
            if let sessionIdStr = event.data["session_id"] as? String,
               let sessionId = UUID(uuidString: sessionIdStr),
               let index = sessions.firstIndex(where: { $0.id == sessionId }) {
                sessions[index].isActive = false
            }

        case .userMessage:
            // Add user message to graph
            if let currentSessionIndex = currentActiveSessionIndex(),
               let content = event.data["content"] as? String {
                let node = GraphNode(
                    id: UUID(),
                    type: .message,
                    parentId: sessions[currentSessionIndex].graph.lastNodeId(),
                    timestamp: Date(),
                    data: [
                        "role": AnyCodable("user"),
                        "text": AnyCodable(content)
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(node)
            }

        case .assistantDelta:
            // Update or create streaming assistant message
            if let currentSessionIndex = currentActiveSessionIndex(),
               let text = event.data["text"] as? String {
                updateStreamingMessage(sessionIndex: currentSessionIndex, deltaText: text)
            }

        case .assistantFinal:
            // Finalize assistant message
            if let currentSessionIndex = currentActiveSessionIndex() {
                finalizeStreamingMessage(sessionIndex: currentSessionIndex)
            }

        case .toolStart:
            // Add tool use node
            if let currentSessionIndex = currentActiveSessionIndex(),
               let toolName = event.data["tool_name"] as? String,
               let toolIdStr = event.data["tool_id"] as? String,
               let toolId = UUID(uuidString: toolIdStr) {
                let node = GraphNode(
                    id: toolId,
                    type: .toolUse,
                    parentId: sessions[currentSessionIndex].graph.lastNodeId(),
                    timestamp: Date(),
                    data: [
                        "tool_name": AnyCodable(toolName),
                        "status": AnyCodable("running"),
                        "input": AnyCodable(event.data["input"] ?? [:])
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(node)
            }

        case .toolEnd:
            // Add tool result node and update tool use status
            if let currentSessionIndex = currentActiveSessionIndex(),
               let toolIdStr = event.data["tool_id"] as? String,
               let toolId = UUID(uuidString: toolIdStr),
               let status = event.data["status"] as? String {

                // Update tool use node status
                if let toolUseNode = sessions[currentSessionIndex].graph.getNode(id: toolId) {
                    var updatedData = toolUseNode.data
                    updatedData["status"] = AnyCodable(status)
                    let updatedNode = GraphNode(
                        id: toolUseNode.id,
                        type: toolUseNode.type,
                        parentId: toolUseNode.parentId,
                        timestamp: toolUseNode.timestamp,
                        data: updatedData
                    )
                    sessions[currentSessionIndex].graph.updateNode(updatedNode)
                }

                // Add tool result node
                let success = status == "completed" || status == "success"
                let resultNode = GraphNode(
                    id: UUID(),
                    type: .toolResult,
                    parentId: toolId,
                    timestamp: Date(),
                    data: [
                        "tool_name": AnyCodable(event.data["tool_name"] ?? ""),
                        "output": AnyCodable(event.data["output"] ?? ""),
                        "byte_count": AnyCodable(event.data["byte_count"] ?? 0),
                        "artifact_ref": AnyCodable(event.data["artifact_ref"] ?? ""),
                        "success": AnyCodable(success)
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(resultNode)
            }

        case .checkpointCreated:
            // Add checkpoint node
            if let currentSessionIndex = currentActiveSessionIndex(),
               let checkpointId = event.data["checkpoint_id"] as? String,
               let label = event.data["label"] as? String {
                let node = GraphNode(
                    id: UUID(uuidString: checkpointId) ?? UUID(),
                    type: .checkpoint,
                    parentId: sessions[currentSessionIndex].graph.lastNodeId(),
                    timestamp: Date(),
                    data: [
                        "label": AnyCodable(label),
                        "jj_commit_id": AnyCodable(event.data["jj_commit_id"] ?? ""),
                        "bookmark_name": AnyCodable(event.data["bookmark_name"] ?? "")
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(node)
            }

        case .checkpointRestored:
            // TODO: Handle checkpoint restoration in graph
            break

        case .skillStart:
            // Add skill run node
            if let currentSessionIndex = currentActiveSessionIndex(),
               let skillId = event.data["skill_id"] as? String,
               let name = event.data["name"] as? String {
                let node = GraphNode(
                    id: UUID(),
                    type: .skillRun,
                    parentId: sessions[currentSessionIndex].graph.lastNodeId(),
                    timestamp: Date(),
                    data: [
                        "skill_id": AnyCodable(skillId),
                        "name": AnyCodable(name),
                        "args": AnyCodable(event.data["args"] ?? ""),
                        "status": AnyCodable("running")
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(node)
            }

        case .skillResult, .skillEnd:
            // TODO: Update skill run node with result/status
            break

        case .subagentStart:
            // Add subagent run node
            if let currentSessionIndex = currentActiveSessionIndex(),
               let subagentIdStr = event.data["subagent_id"] as? String,
               let subagentId = UUID(uuidString: subagentIdStr),
               let subagentType = event.data["subagent_type"] as? String {
                let node = GraphNode(
                    id: subagentId,
                    type: .subagentRun,
                    parentId: sessions[currentSessionIndex].graph.lastNodeId(),
                    timestamp: Date(),
                    data: [
                        "subagent_type": AnyCodable(subagentType),
                        "prompt": AnyCodable(event.data["prompt"] ?? ""),
                        "status": AnyCodable("running")
                    ]
                )
                sessions[currentSessionIndex].graph.addNode(node)
            }

        case .subagentEnd:
            // TODO: Update subagent run node with status
            break

        case .error:
            // Display error
            if let message = event.data["message"] as? String {
                error = message
            }

        default:
            print("Unhandled event type: \(event.type)")
        }
    }

    // MARK: - Helper Methods

    private func currentActiveSessionIndex() -> Int? {
        sessions.firstIndex(where: { $0.isActive })
    }

    private var streamingMessageId: UUID?
    private var streamingMessageText: String = ""

    private func updateStreamingMessage(sessionIndex: Int, deltaText: String) {
        streamingMessageText += deltaText

        if let messageId = streamingMessageId {
            // Update existing node
            if let node = sessions[sessionIndex].graph.getNode(id: messageId) {
                var updatedData = node.data
                updatedData["text"] = AnyCodable(streamingMessageText)
                updatedData["is_streaming"] = AnyCodable(true)
                let updatedNode = GraphNode(
                    id: node.id,
                    type: node.type,
                    parentId: node.parentId,
                    timestamp: node.timestamp,
                    data: updatedData
                )
                sessions[sessionIndex].graph.updateNode(updatedNode)
            }
        } else {
            // Create new node
            let nodeId = UUID()
            let node = GraphNode(
                id: nodeId,
                type: .message,
                parentId: sessions[sessionIndex].graph.lastNodeId(),
                timestamp: Date(),
                data: [
                    "role": AnyCodable("assistant"),
                    "text": AnyCodable(streamingMessageText),
                    "is_streaming": AnyCodable(true)
                ]
            )
            sessions[sessionIndex].graph.addNode(node)
            streamingMessageId = nodeId
        }
    }

    private func finalizeStreamingMessage(sessionIndex: Int) {
        // Update the streaming message to mark it as complete
        if let messageId = streamingMessageId,
           let node = sessions[sessionIndex].graph.getNode(id: messageId) {
            var updatedData = node.data
            updatedData["is_streaming"] = AnyCodable(false)
            let updatedNode = GraphNode(
                id: node.id,
                type: node.type,
                parentId: node.parentId,
                timestamp: node.timestamp,
                data: updatedData
            )
            sessions[sessionIndex].graph.updateNode(updatedNode)
        }

        // Clear streaming state
        streamingMessageId = nil
        streamingMessageText = ""
    }
}

enum SessionManagerError: Error {
    case notConnected
}
