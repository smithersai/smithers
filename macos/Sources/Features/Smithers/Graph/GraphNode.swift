import Foundation

/// Types of nodes in the session graph
enum GraphNodeType: String, Codable {
    case message         // User or assistant message
    case toolUse         // Tool invocation
    case toolResult      // Tool result (references artifact)
    case checkpoint      // Code snapshot
    case subagentRun     // Subagent execution
    case skillRun        // Skill execution
    case promptRebase    // Prompt rebase point
    case browserSnapshot // Captured browser state
}

/// A node in the session graph
struct GraphNode: Identifiable, Codable, Equatable {
    let id: UUID
    let type: GraphNodeType
    let parentId: UUID?
    let timestamp: Date
    var data: [String: AnyCodable]

    static func == (lhs: GraphNode, rhs: GraphNode) -> Bool {
        lhs.id == rhs.id && lhs.type == rhs.type && lhs.parentId == rhs.parentId
    }

    // Computed properties for common data fields
    var text: String? {
        data["text"]?.value as? String
    }

    var toolName: String? {
        data["tool_name"]?.value as? String
    }

    var artifactRef: String? {
        data["artifact_ref"]?.value as? String
    }
}

/// The session graph - a DAG of nodes
class SessionGraph: ObservableObject {
    @Published var nodes: [UUID: GraphNode] = [:]
    @Published var rootIds: [UUID] = []

    /// All nodes in topological order
    var orderedNodes: [GraphNode] {
        var result: [GraphNode] = []
        var visited = Set<UUID>()

        func visit(_ id: UUID) {
            guard !visited.contains(id), let node = nodes[id] else { return }
            visited.insert(id)
            if let parentId = node.parentId {
                visit(parentId)
            }
            result.append(node)
        }

        for id in nodes.keys {
            visit(id)
        }

        return result
    }

    /// Children of a node
    func children(of nodeId: UUID) -> [GraphNode] {
        nodes.values.filter { $0.parentId == nodeId }
    }

    /// Add a node to the graph
    func addNode(_ node: GraphNode) {
        nodes[node.id] = node
        if node.parentId == nil {
            rootIds.append(node.id)
        }
    }

    /// Update an existing node in the graph
    func updateNode(_ node: GraphNode) {
        nodes[node.id] = node
    }

    /// Get a node by ID
    func getNode(id: UUID) -> GraphNode? {
        nodes[id]
    }

    /// Get the ID of the last node added (for building parent chains)
    func lastNodeId() -> UUID? {
        orderedNodes.last?.id
    }

    /// Project to chat items (for Chat Mode)
    /// Returns both messages and tools in chronological order
    func projectToChat() -> [ChatItem] {
        var items: [ChatItem] = []
        var toolUseNodes: [UUID: GraphNode] = [:]

        // First pass: collect tool uses
        for node in orderedNodes where node.type == .toolUse {
            toolUseNodes[node.id] = node
        }

        // Second pass: create chat items
        for node in orderedNodes {
            switch node.type {
            case .message:
                let role = (node.data["role"]?.value as? String) ?? "assistant"
                let isStreaming = (node.data["is_streaming"]?.value as? Bool) ?? false
                items.append(.message(ChatMessage(
                    id: node.id,
                    role: role == "user" ? .user : .assistant,
                    content: node.text ?? "",
                    timestamp: node.timestamp,
                    isStreaming: isStreaming
                )))

            case .toolUse:
                // Find corresponding result if it exists
                let resultNode = orderedNodes.first { result in
                    result.type == .toolResult &&
                    (result.parentId == node.id ||
                     (result.data["tool_use_id"]?.value as? String) == node.id.uuidString)
                }

                let result: ToolResult?
                if let resultNode = resultNode {
                    let success = (resultNode.data["success"]?.value as? Bool) ?? true
                    let output = (resultNode.data["output"]?.value as? String) ?? resultNode.text ?? ""
                    result = ToolResult(success: success, fullOutput: output)
                } else {
                    result = nil
                }

                // Extract tool input - try multiple formats
                let inputText: String
                if let inputDict = node.data["input"]?.value as? [String: Any] {
                    // Format as key: value pairs
                    inputText = inputDict.map { key, value in
                        "\(key): \(value)"
                    }.joined(separator: "\n")
                } else if let inputStr = node.data["input"]?.value as? String {
                    inputText = inputStr
                } else {
                    inputText = node.text ?? ""
                }

                let status = (node.data["status"]?.value as? String) ?? "pending"
                let isRunning = status == "running"
                items.append(.tool(ToolMessage(
                    id: node.id,
                    name: node.toolName ?? "Unknown",
                    input: inputText,
                    result: result,
                    timestamp: node.timestamp,
                    isRunning: isRunning
                )))

            default:
                // Skip other node types in chat view
                break
            }
        }

        return items
    }
}

/// A chat item - either a message or a tool
enum ChatItem: Identifiable {
    case message(ChatMessage)
    case tool(ToolMessage)

    var id: UUID {
        switch self {
        case .message(let msg):
            return msg.id
        case .tool(let tool):
            return tool.id
        }
    }

    var timestamp: Date {
        switch self {
        case .message(let msg):
            return msg.timestamp
        case .tool(let tool):
            return tool.timestamp
        }
    }
}

/// A chat message (projection from graph)
struct ChatMessage: Identifiable {
    enum Role {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    let content: String
    let timestamp: Date
    var isStreaming: Bool = false
}

/// Tool message data
struct ToolMessage: Identifiable {
    let id: UUID
    let name: String
    let input: String
    let result: ToolResult?
    let timestamp: Date
    var isRunning: Bool = false
}

/// Tool execution result
struct ToolResult {
    let success: Bool
    let fullOutput: String
    let preview: String

    init(success: Bool, fullOutput: String, previewLines: Int = 20) {
        self.success = success
        self.fullOutput = fullOutput

        // Create preview (first N lines)
        let lines = fullOutput.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > previewLines {
            self.preview = lines.prefix(previewLines).joined(separator: "\n") + "\n\n... (\(lines.count - previewLines) more lines)"
        } else {
            self.preview = fullOutput
        }
    }
}
