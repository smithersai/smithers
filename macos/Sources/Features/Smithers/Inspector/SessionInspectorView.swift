import SwiftUI

/// Inspector tab types
enum InspectorTab: String, CaseIterable, Identifiable {
    case stack = "Stack"
    case diff = "Diff"
    case todos = "Todos"
    case browser = "Browser"
    case tools = "Tools"
    case runDetails = "Run Details"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .stack: return "square.stack.3d.up"
        case .diff: return "doc.text.magnifyingglass"
        case .todos: return "checklist"
        case .browser: return "safari"
        case .tools: return "wrench.and.screwdriver"
        case .runDetails: return "info.circle"
        }
    }
}

/// Right inspector panel with tabs for various tools and views
struct SessionInspectorView: View {
    @Binding var selectedTab: InspectorTab
    @Binding var selectedNodeId: UUID?

    var body: some View {
        VStack(spacing: 0) {
            // Tab picker
            tabPicker

            Divider()

            // Tab content
            tabContent
        }
        .frame(minWidth: 320, maxWidth: 420)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Subviews

    private var tabPicker: some View {
        Picker("Inspector Tab", selection: $selectedTab) {
            ForEach(InspectorTab.allCases) { tab in
                Label(tab.rawValue, systemImage: tab.icon)
                    .tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .padding(8)
    }

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .stack:
            StackView(selectedNodeId: $selectedNodeId)
        case .diff:
            DiffView(selectedNodeId: $selectedNodeId)
        case .todos:
            TodosView()
        case .browser:
            BrowserView()
        case .tools:
            ToolsView(selectedNodeId: $selectedNodeId)
        case .runDetails:
            RunDetailsView(selectedNodeId: $selectedNodeId)
        }
    }
}

// MARK: - Tab Views (Placeholders)

/// Stack view showing JJ commit stack
struct StackView: View {
    @Binding var selectedNodeId: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Stack")
                    .font(.headline)
                    .padding()

                Text("JJ commit stack will be displayed here")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding(.horizontal)

                Spacer()
            }
        }
    }
}

/// Diff viewer for comparing changes
struct DiffView: View {
    @Binding var selectedNodeId: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Diff")
                    .font(.headline)
                    .padding()

                Text("File diffs will be displayed here")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding(.horizontal)

                Spacer()
            }
        }
    }
}

/// Todos panel for managing tasks
struct TodosView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Todos")
                        .font(.headline)

                    Spacer()

                    Button(action: addTodo) {
                        Image(systemName: "plus.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(.accentColor)
                }
                .padding()

                Text("Todo list will be displayed here")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding(.horizontal)

                Spacer()
            }
        }
    }

    private func addTodo() {
        // TODO: Implement add todo
        print("Add todo")
    }
}

/// Browser tab for web snapshots and forms
struct BrowserView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Browser")
                    .font(.headline)
                    .padding()

                Text("Browser snapshots and forms will be displayed here")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding(.horizontal)

                Spacer()
            }
        }
    }
}

/// Tools view showing tool invocations and details
struct ToolsView: View {
    @Binding var selectedNodeId: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack {
                    Text("Tools")
                        .font(.headline)
                    Spacer()
                }
                .padding()

                Divider()

                if let nodeId = selectedNodeId,
                   let node = MockDataService.shared.getNode(id: nodeId) {
                    toolDetailsView(for: node)
                } else {
                    emptyStateView
                }
            }
        }
    }

    @ViewBuilder
    private func toolDetailsView(for node: GraphNode) -> some View {
        switch node.type {
        case .toolUse:
            toolUseDetails(for: node)
        case .toolResult:
            toolResultDetails(for: node)
        default:
            VStack(alignment: .leading, spacing: 12) {
                Text("Not a tool node")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .padding()
                Spacer()
            }
        }
    }

    private func toolUseDetails(for node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            // Tool name with icon
            HStack(spacing: 12) {
                Image(systemName: toolIcon(for: node.toolName))
                    .font(.system(size: 32))
                    .foregroundColor(.accentColor)

                VStack(alignment: .leading, spacing: 4) {
                    Text(node.toolName ?? "Unknown Tool")
                        .font(.title2)
                        .fontWeight(.semibold)

                    Text("Tool Invocation")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding()

            Divider()

            // Status badge
            HStack {
                statusBadge(for: node)
                Spacer()
            }
            .padding(.horizontal)

            // Tool input parameters
            if let input = node.data["input"]?.value as? [String: Any], !input.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Input")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)

                    ForEach(Array(input.keys.sorted()), id: \.self) { key in
                        if let value = input[key] {
                            parameterRow(key: key, value: "\(value)")
                        }
                    }
                }
                .padding()
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .cornerRadius(8)
                .padding(.horizontal)
            }

            // Metadata
            VStack(alignment: .leading, spacing: 8) {
                Text("Metadata")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.secondary)

                DetailRow(label: "Node ID", value: node.id.uuidString)
                DetailRow(label: "Timestamp", value: formatTimestamp(node.timestamp))

                if let duration = node.data["duration"]?.value as? Double {
                    DetailRow(label: "Duration", value: String(format: "%.2fs", duration))
                }
            }
            .padding()

            Spacer()
        }
    }

    private func toolResultDetails(for node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header
            HStack(spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.system(size: 32))
                    .foregroundColor(.green)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Tool Result")
                        .font(.title2)
                        .fontWeight(.semibold)

                    if let toolName = node.data["tool_name"]?.value as? String {
                        Text(toolName)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding()

            Divider()

            // Output preview
            if let output = node.data["output"]?.value as? String {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Output")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)

                    Text(output)
                        .font(.system(size: 12, design: .monospaced))
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(nsColor: .textBackgroundColor))
                        .cornerRadius(8)
                        .textSelection(.enabled)
                }
                .padding(.horizontal)
            }

            // Artifact reference
            if let artifactRef = node.artifactRef {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Artifact")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)

                    HStack {
                        Image(systemName: "doc.on.doc")
                        Text(artifactRef)
                            .font(.system(size: 11, design: .monospaced))
                        Spacer()
                        Button(action: {}) {
                            Text("Open")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding()
                    .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                    .cornerRadius(8)
                }
                .padding(.horizontal)
            }

            // Metadata
            VStack(alignment: .leading, spacing: 8) {
                Text("Metadata")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.secondary)

                DetailRow(label: "Node ID", value: node.id.uuidString)
                DetailRow(label: "Timestamp", value: formatTimestamp(node.timestamp))

                if let byteCount = node.data["byte_count"]?.value as? Int {
                    DetailRow(label: "Size", value: formatBytes(byteCount))
                }
            }
            .padding()

            Spacer()
        }
    }

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))

            Text("No tool selected")
                .font(.headline)
                .foregroundColor(.secondary)

            Text("Select a tool invocation from the graph or chat to see details")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 200)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    // MARK: - Helper Views

    private func parameterRow(key: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(key)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
        }
    }

    private func statusBadge(for node: GraphNode) -> some View {
        let status = node.data["status"]?.value as? String ?? "completed"
        let color: Color = {
            switch status {
            case "running": return .blue
            case "completed": return .green
            case "error": return .red
            default: return .gray
            }
        }()

        return HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(status.capitalized)
                .font(.caption)
                .fontWeight(.medium)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(color.opacity(0.15))
        .cornerRadius(12)
    }

    // MARK: - Helper Functions

    private func toolIcon(for toolName: String?) -> String {
        switch toolName {
        case "Read": return "doc.text"
        case "Edit": return "pencil"
        case "Write": return "doc.badge.plus"
        case "Bash": return "terminal"
        case "Glob": return "doc.text.magnifyingglass"
        case "Grep": return "text.magnifyingglass"
        default: return "wrench.and.screwdriver"
        }
    }

    private func formatTimestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// MARK: - Mock Data Service

class MockDataService {
    static let shared = MockDataService()

    private var nodes: [UUID: GraphNode] = [:]

    func registerNode(_ node: GraphNode) {
        nodes[node.id] = node
    }

    func getNode(id: UUID) -> GraphNode? {
        nodes[id]
    }

    func reset() {
        nodes.removeAll()
    }
}

/// Run details view showing execution metadata
struct RunDetailsView: View {
    @Binding var selectedNodeId: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Run Details")
                    .font(.headline)
                    .padding()

                if selectedNodeId != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        DetailRow(label: "Node ID", value: selectedNodeId?.uuidString ?? "")
                        DetailRow(label: "Status", value: "Completed")
                        DetailRow(label: "Duration", value: "2.3s")
                        DetailRow(label: "Tokens", value: "1,234")
                    }
                    .padding(.horizontal)
                } else {
                    Text("Select a node to see run details")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)
                }

                Spacer()
            }
        }
    }
}

/// Detail row for key-value pairs
struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.body)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Preview

#Preview("Inspector - Stack") {
    SessionInspectorView(
        selectedTab: .constant(.stack),
        selectedNodeId: .constant(nil)
    )
    .frame(width: 350, height: 600)
}

#Preview("Inspector - Tools with Tool Use") {
    // Create a mock tool use node
    let toolUseNode = GraphNode(
        id: UUID(),
        type: .toolUse,
        parentId: nil,
        timestamp: Date(),
        data: [
            "tool_name": AnyCodable("Read"),
            "status": AnyCodable("completed"),
            "input": AnyCodable([
                "file_path": "/workspace/auth.py",
                "line_start": 1,
                "line_end": 100
            ] as [String: Any]),
            "duration": AnyCodable(0.42)
        ]
    )
    MockDataService.shared.registerNode(toolUseNode)

    return SessionInspectorView(
        selectedTab: .constant(.tools),
        selectedNodeId: .constant(toolUseNode.id)
    )
    .frame(width: 400, height: 600)
}

#Preview("Inspector - Tools with Tool Result") {
    // Create a mock tool result node
    let toolResultNode = GraphNode(
        id: UUID(),
        type: .toolResult,
        parentId: nil,
        timestamp: Date(),
        data: [
            "tool_name": AnyCodable("Bash"),
            "output": AnyCodable("============================= test session starts ==============================\ntests/test_auth.py::test_valid_token PASSED [ 33%]\ntests/test_auth.py::test_expired_token PASSED [ 66%]\ntests/test_auth.py::test_invalid_token PASSED [100%]\n\n============================== 3 passed in 0.12s ==============================="),
            "byte_count": AnyCodable(312),
            "artifact_ref": AnyCodable("artifact://bash-pytest-001")
        ]
    )
    MockDataService.shared.registerNode(toolResultNode)

    return SessionInspectorView(
        selectedTab: .constant(.tools),
        selectedNodeId: .constant(toolResultNode.id)
    )
    .frame(width: 400, height: 600)
}

#Preview("Inspector - Tools Empty") {
    SessionInspectorView(
        selectedTab: .constant(.tools),
        selectedNodeId: .constant(nil)
    )
    .frame(width: 350, height: 600)
}
