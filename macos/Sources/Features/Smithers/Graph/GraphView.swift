import SwiftUI

/// Interactive graph view with pan, zoom, and node selection
struct GraphView: View {
    @ObservedObject var graph: SessionGraph
    @Binding var selectedNodeId: UUID?

    @State private var offset = CGSize.zero
    @State private var previousOffset = CGSize.zero
    @State private var scale: CGFloat = 1.0
    @State private var previousScale: CGFloat = 1.0
    @State private var layoutResult: GraphLayoutResult?

    private let layoutEngine = GraphLayoutEngine()

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Background
                Color(nsColor: .textBackgroundColor)

                if let layout = layoutResult {
                    Canvas { context, size in
                        // Apply transforms for pan and zoom
                        context.translateBy(x: offset.width, y: offset.height)
                        context.scaleBy(x: scale, y: scale)

                        // Draw edges first (behind nodes)
                        drawEdges(in: context, layout: layout)

                        // Draw nodes on top
                        drawNodes(in: context, layout: layout)
                    }
                } else {
                    // Loading state
                    ProgressView()
                        .scaleEffect(1.5)
                }
            }
            .gesture(dragGesture)
            .gesture(magnificationGesture)
            .onTapGesture { location in
                handleTap(at: location)
            }
            .onAppear {
                computeLayout()
            }
            .onChange(of: graph.nodes) { _ in
                computeLayout()
            }
        }
    }

    // MARK: - Drawing

    private func drawEdges(in context: GraphicsContext, layout: GraphLayoutResult) {
        for edge in layout.edges {
            guard edge.points.count >= 2 else { continue }

            var path = Path()
            path.move(to: edge.points[0])

            for i in 1..<edge.points.count {
                path.addLine(to: edge.points[i])
            }

            context.stroke(
                path,
                with: .color(.secondary.opacity(0.3)),
                lineWidth: 2
            )
        }
    }

    private func drawNodes(in context: GraphicsContext, layout: GraphLayoutResult) {
        for layoutNode in layout.nodes {
            guard let node = graph.nodes[layoutNode.id] else { continue }

            let isSelected = selectedNodeId == layoutNode.id

            // Draw node background
            let nodeRect = layoutNode.bounds
            let roundedRect = RoundedRectangle(cornerRadius: 8)
            let backgroundColor = isSelected ?
                Color.accentColor.opacity(0.2) :
                Color(nsColor: .controlBackgroundColor)

            context.fill(
                roundedRect.path(in: nodeRect),
                with: .color(backgroundColor)
            )

            // Draw node border
            let borderColor = isSelected ? Color.accentColor : Color.secondary.opacity(0.3)
            context.stroke(
                roundedRect.path(in: nodeRect),
                with: .color(borderColor),
                lineWidth: isSelected ? 2 : 1
            )

            // Draw node type indicator (colored bar on left)
            let indicatorRect = CGRect(
                x: nodeRect.minX,
                y: nodeRect.minY,
                width: 4,
                height: nodeRect.height
            )
            context.fill(
                RoundedRectangle(cornerRadius: 2).path(in: indicatorRect),
                with: .color(colorForNodeType(node.type))
            )

            // Draw node label
            let text = labelForNode(node)
            let textPosition = CGPoint(
                x: nodeRect.minX + 12,
                y: nodeRect.minY + nodeRect.height / 2
            )

            context.draw(
                Text(text)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.primary),
                at: textPosition,
                anchor: .leading
            )
        }
    }

    // MARK: - Gestures

    private var dragGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                offset = CGSize(
                    width: previousOffset.width + value.translation.width,
                    height: previousOffset.height + value.translation.height
                )
            }
            .onEnded { _ in
                previousOffset = offset
            }
    }

    private var magnificationGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                scale = max(0.5, min(2.0, previousScale * value))
            }
            .onEnded { _ in
                previousScale = scale
            }
    }

    private func handleTap(at location: CGPoint) {
        guard let layout = layoutResult else { return }

        // Transform tap location to graph coordinates
        let transformedLocation = CGPoint(
            x: (location.x - offset.width) / scale,
            y: (location.y - offset.height) / scale
        )

        // Find tapped node
        for layoutNode in layout.nodes {
            if layoutNode.bounds.contains(transformedLocation) {
                selectedNodeId = layoutNode.id
                return
            }
        }

        // Tapped empty space - deselect
        selectedNodeId = nil
    }

    // MARK: - Layout

    private func computeLayout() {
        layoutResult = layoutEngine.layout(graph)

        // Auto-fit on first layout
        if offset == .zero && scale == 1.0, let layout = layoutResult {
            centerLayout(layout)
        }
    }

    private func centerLayout(_ layout: GraphLayoutResult) {
        // Center the graph in the view
        // This is a simple centering - can be improved with proper viewport fitting
        offset = CGSize(width: 50, height: 50)
    }

    // MARK: - Helpers

    private func colorForNodeType(_ type: GraphNodeType) -> Color {
        switch type {
        case .message:
            return .blue
        case .toolUse:
            return .purple
        case .toolResult:
            return .green
        case .checkpoint:
            return .orange
        case .subagentRun:
            return .pink
        case .skillRun:
            return .cyan
        case .promptRebase:
            return .yellow
        case .browserSnapshot:
            return .indigo
        }
    }

    private func labelForNode(_ node: GraphNode) -> String {
        switch node.type {
        case .message:
            let role = (node.data["role"]?.value as? String) ?? "assistant"
            let preview = node.text?.prefix(40) ?? ""
            return "\(role): \(preview)"
        case .toolUse:
            return "🔧 \(node.toolName ?? "Tool")"
        case .toolResult:
            return "✓ Result"
        case .checkpoint:
            return "📍 Checkpoint"
        case .subagentRun:
            return "🤖 Subagent"
        case .skillRun:
            return "⚡ Skill"
        case .promptRebase:
            return "🔄 Rebase"
        case .browserSnapshot:
            return "🌐 Browser"
        }
    }
}

// MARK: - Preview

#Preview("Graph View") {
    @State var selectedNodeId: UUID?
    let graph = SessionGraph()

    // Add some mock nodes
    let root = GraphNode(
        id: UUID(),
        type: .message,
        parentId: nil,
        timestamp: Date(),
        data: ["role": AnyCodable("user"), "text": AnyCodable("Hello, can you help me?")]
    )
    graph.addNode(root)

    let response = GraphNode(
        id: UUID(),
        type: .message,
        parentId: root.id,
        timestamp: Date(),
        data: ["role": AnyCodable("assistant"), "text": AnyCodable("Of course! What do you need help with?")]
    )
    graph.addNode(response)

    let toolUse = GraphNode(
        id: UUID(),
        type: .toolUse,
        parentId: response.id,
        timestamp: Date(),
        data: ["tool_name": AnyCodable("read_file")]
    )
    graph.addNode(toolUse)

    let toolResult = GraphNode(
        id: UUID(),
        type: .toolResult,
        parentId: toolUse.id,
        timestamp: Date(),
        data: ["artifact_ref": AnyCodable("file-123")]
    )
    graph.addNode(toolResult)

    return GraphView(graph: graph, selectedNodeId: $selectedNodeId)
        .frame(width: 800, height: 600)
}
