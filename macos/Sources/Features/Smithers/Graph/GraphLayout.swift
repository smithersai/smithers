import Foundation
import CoreGraphics

/// A positioned node in the graph layout
struct LayoutNode {
    let id: UUID
    let position: CGPoint
    let size: CGSize

    var bounds: CGRect {
        CGRect(origin: position, size: size)
    }

    var center: CGPoint {
        CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
    }
}

/// An edge between two nodes with routing points
struct LayoutEdge {
    let from: UUID
    let to: UUID
    let points: [CGPoint]
}

/// Layout result containing positioned nodes and edges
struct GraphLayoutResult {
    let nodes: [LayoutNode]
    let edges: [LayoutEdge]
    let bounds: CGRect

    /// Find a node by ID
    func node(for id: UUID) -> LayoutNode? {
        nodes.first { $0.id == id }
    }
}

/// Graph layout engine using a Sugiyama-style hierarchical algorithm
class GraphLayoutEngine {
    // Layout configuration
    struct Config {
        var nodeWidth: CGFloat = 120
        var nodeHeight: CGFloat = 60
        var horizontalSpacing: CGFloat = 80
        var verticalSpacing: CGFloat = 80
        var padding: CGFloat = 40
    }

    let config: Config

    init(config: Config = Config()) {
        self.config = config
    }

    /// Compute layout for a session graph
    func layout(_ graph: SessionGraph) -> GraphLayoutResult {
        // Step 1: Build adjacency list and identify roots
        var children: [UUID: [UUID]] = [:]
        var parents: [UUID: UUID] = [:]
        var allNodes: Set<UUID> = []

        for node in graph.nodes.values {
            allNodes.insert(node.id)
            if let parentId = node.parentId {
                children[parentId, default: []].append(node.id)
                parents[node.id] = parentId
            }
        }

        // Identify root nodes (nodes with no parent)
        let roots = allNodes.filter { parents[$0] == nil }

        // Step 2: Assign layers (topological levels)
        var layers: [[UUID]] = []
        var nodeToLayer: [UUID: Int] = [:]
        var visited: Set<UUID> = []

        func assignLayers(_ nodeId: UUID, layer: Int) {
            guard !visited.contains(nodeId) else { return }
            visited.insert(nodeId)

            // Ensure we have enough layers
            while layers.count <= layer {
                layers.append([])
            }

            layers[layer].append(nodeId)
            nodeToLayer[nodeId] = layer

            // Process children in next layer
            if let nodeChildren = children[nodeId] {
                for childId in nodeChildren {
                    assignLayers(childId, layer: layer + 1)
                }
            }
        }

        // Assign layers starting from roots
        for root in roots.sorted() {
            assignLayers(root, layer: 0)
        }

        // Step 3: Reduce edge crossings using barycenter heuristic
        self.optimizeNodeOrdering(&layers, children: children, parents: parents)

        // Step 4: Position nodes
        var layoutNodes: [LayoutNode] = []
        let nodeSize = CGSize(width: config.nodeWidth, height: config.nodeHeight)

        for (layerIndex, layerNodes) in layers.enumerated() {
            let y = config.padding + CGFloat(layerIndex) * (config.nodeHeight + config.verticalSpacing)

            // Center nodes horizontally in each layer
            let layerWidth = CGFloat(layerNodes.count) * config.nodeWidth +
                            CGFloat(max(0, layerNodes.count - 1)) * config.horizontalSpacing
            let startX = config.padding

            for (nodeIndex, nodeId) in layerNodes.enumerated() {
                let x = startX + CGFloat(nodeIndex) * (config.nodeWidth + config.horizontalSpacing)
                let position = CGPoint(x: x, y: y)

                layoutNodes.append(LayoutNode(
                    id: nodeId,
                    position: position,
                    size: nodeSize
                ))
            }
        }

        // Step 5: Create edges with simple routing
        var layoutEdges: [LayoutEdge] = []
        let nodeMap = Dictionary(uniqueKeysWithValues: layoutNodes.map { ($0.id, $0) })

        for node in graph.nodes.values {
            guard let parentId = node.parentId,
                  let fromNode = nodeMap[parentId],
                  let toNode = nodeMap[node.id] else {
                continue
            }

            // Smooth Bezier curve routing from bottom-center of parent to top-center of child
            let fromPoint = CGPoint(
                x: fromNode.center.x,
                y: fromNode.position.y + fromNode.size.height
            )
            let toPoint = CGPoint(
                x: toNode.center.x,
                y: toNode.position.y
            )

            // Create control points for a smooth cubic Bezier curve
            // The curve should flow downward from parent to child
            let verticalDistance = toPoint.y - fromPoint.y
            let controlPointOffset = max(verticalDistance * 0.4, 20.0)

            let controlPoint1 = CGPoint(
                x: fromPoint.x,
                y: fromPoint.y + controlPointOffset
            )
            let controlPoint2 = CGPoint(
                x: toPoint.x,
                y: toPoint.y - controlPointOffset
            )

            layoutEdges.append(LayoutEdge(
                from: parentId,
                to: node.id,
                points: [fromPoint, controlPoint1, controlPoint2, toPoint]
            ))
        }

        // Step 6: Calculate bounds
        let maxX = layoutNodes.map { $0.position.x + $0.size.width }.max() ?? 0
        let maxY = layoutNodes.map { $0.position.y + $0.size.height }.max() ?? 0
        let bounds = CGRect(
            x: 0,
            y: 0,
            width: maxX + config.padding,
            height: maxY + config.padding
        )

        return GraphLayoutResult(
            nodes: layoutNodes,
            edges: layoutEdges,
            bounds: bounds
        )
    }

    // MARK: - Crossing Reduction Helpers

    /// Direction for barycenter ordering
    private enum OrderDirection {
        case up, down
    }

    /// Optimize node ordering within layers to reduce edge crossings
    /// Uses the barycenter heuristic - positions nodes based on average position of neighbors
    private func optimizeNodeOrdering(_ layers: inout [[UUID]], children: [UUID: [UUID]], parents: [UUID: UUID]) {
        // Perform multiple passes to iteratively improve ordering
        let passes = 4
        for pass in 0..<passes {
            // Alternate between top-down and bottom-up passes
            if pass % 2 == 0 {
                // Top-down: order based on children positions
                for layerIndex in 0..<(layers.count - 1) {
                    orderByBarycenter(&layers[layerIndex + 1], relativeTo: layers[layerIndex], children: children, parents: parents, direction: .down)
                }
            } else {
                // Bottom-up: order based on parent positions
                for layerIndex in (1..<layers.count).reversed() {
                    orderByBarycenter(&layers[layerIndex], relativeTo: layers[layerIndex - 1], children: children, parents: parents, direction: .up)
                }
            }
        }
    }

    /// Order nodes in a layer based on barycenter of connected nodes in adjacent layer
    private func orderByBarycenter(_ layer: inout [UUID], relativeTo adjacentLayer: [UUID], children: [UUID: [UUID]], parents: [UUID: UUID], direction: OrderDirection) {
        // Build position map for adjacent layer
        var adjacentPositions: [UUID: Int] = [:]
        for (index, nodeId) in adjacentLayer.enumerated() {
            adjacentPositions[nodeId] = index
        }

        // Calculate barycenter for each node in current layer
        var nodeBarycenters: [(UUID, Double)] = layer.map { nodeId in
            var connectedPositions: [Int] = []

            switch direction {
            case .down:
                // Connected to children in layer below
                if let nodeChildren = children[nodeId] {
                    connectedPositions = nodeChildren.compactMap { adjacentPositions[$0] }
                }
            case .up:
                // Connected to parent in layer above
                if let parentId = parents[nodeId], let parentPos = adjacentPositions[parentId] {
                    connectedPositions = [parentPos]
                }
            }

            let barycenter = connectedPositions.isEmpty ? Double(layer.count) / 2.0 : Double(connectedPositions.reduce(0, +)) / Double(connectedPositions.count)
            return (nodeId, barycenter)
        }

        // Sort by barycenter
        nodeBarycenters.sort { $0.1 < $1.1 }

        // Update layer with new ordering
        layer = nodeBarycenters.map { $0.0 }
    }
}
