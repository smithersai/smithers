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

    /// Project to chat messages (for Chat Mode)
    func projectToChat() -> [ChatMessage] {
        orderedNodes.compactMap { node -> ChatMessage? in
            switch node.type {
            case .message:
                let role = (node.data["role"]?.value as? String) ?? "assistant"
                return ChatMessage(
                    id: node.id,
                    role: role == "user" ? .user : .assistant,
                    content: node.text ?? "",
                    timestamp: node.timestamp
                )
            default:
                return nil
            }
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
}
