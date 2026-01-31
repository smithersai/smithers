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
            VStack(alignment: .leading, spacing: 12) {
                Text("Tools")
                    .font(.headline)
                    .padding()

                if selectedNodeId != nil {
                    Text("Tool details for selected node will be displayed here")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)
                } else {
                    Text("Select a tool invocation to see details")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .padding(.horizontal)
                }

                Spacer()
            }
        }
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

#Preview("Inspector - Tools with Selection") {
    SessionInspectorView(
        selectedTab: .constant(.tools),
        selectedNodeId: .constant(UUID())
    )
    .frame(width: 350, height: 600)
}
