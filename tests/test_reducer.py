"""Tests for session graph reducer."""

from datetime import UTC, datetime

from agentd.reducer import (
    GraphNode,
    GraphNodeType,
    SessionGraph,
    reduce_events,
)


class TestGraphNode:
    """Tests for GraphNode."""

    def test_create_node(self):
        """Test creating a graph node."""
        from uuid import uuid4

        node_id = uuid4()
        ts = datetime.now(UTC)
        node = GraphNode(
            id=node_id,
            type=GraphNodeType.MESSAGE,
            parent_id=None,
            timestamp=ts,
            data={"text": "Hello", "role": "user"},
        )

        assert node.id == node_id
        assert node.type == GraphNodeType.MESSAGE
        assert node.parent_id is None
        assert node.timestamp == ts
        assert node.text == "Hello"
        assert node.role == "user"

    def test_node_properties(self):
        """Test node property accessors."""
        from uuid import uuid4

        node = GraphNode(
            id=uuid4(),
            type=GraphNodeType.TOOL_USE,
            parent_id=None,
            timestamp=datetime.now(UTC),
            data={
                "tool_name": "bash",
                "artifact_ref": "artifact-123",
            },
        )

        assert node.tool_name == "bash"
        assert node.artifact_ref == "artifact-123"
        assert node.text is None
        assert node.role is None

    def test_to_dict(self):
        """Test node serialization."""
        from uuid import uuid4

        node_id = uuid4()
        parent_id = uuid4()
        ts = datetime.now(UTC)

        node = GraphNode(
            id=node_id,
            type=GraphNodeType.MESSAGE,
            parent_id=parent_id,
            timestamp=ts,
            data={"text": "Hello"},
        )

        d = node.to_dict()
        assert d["id"] == str(node_id)
        assert d["type"] == "message"
        assert d["parent_id"] == str(parent_id)
        assert d["timestamp"] == ts.isoformat()
        assert d["data"] == {"text": "Hello"}


class TestSessionGraph:
    """Tests for SessionGraph."""

    def test_empty_graph(self):
        """Test creating an empty graph."""
        graph = SessionGraph()
        assert len(graph.nodes) == 0
        assert len(graph.root_ids) == 0

    def test_add_node(self):
        """Test adding nodes to graph."""
        from uuid import uuid4

        graph = SessionGraph()
        node1_id = uuid4()
        node2_id = uuid4()

        node1 = GraphNode(
            id=node1_id,
            type=GraphNodeType.MESSAGE,
            parent_id=None,
            timestamp=datetime.now(UTC),
            data={"text": "User message"},
        )
        graph.add_node(node1)

        assert node1_id in graph.nodes
        assert node1_id in graph.root_ids

        node2 = GraphNode(
            id=node2_id,
            type=GraphNodeType.MESSAGE,
            parent_id=node1_id,
            timestamp=datetime.now(UTC),
            data={"text": "Assistant reply"},
        )
        graph.add_node(node2)

        assert node2_id in graph.nodes
        assert node2_id not in graph.root_ids  # Has parent

    def test_children(self):
        """Test getting children of a node."""
        from uuid import uuid4

        graph = SessionGraph()
        parent_id = uuid4()
        child1_id = uuid4()
        child2_id = uuid4()

        parent = GraphNode(
            id=parent_id,
            type=GraphNodeType.MESSAGE,
            parent_id=None,
            timestamp=datetime.now(UTC),
            data={},
        )
        graph.add_node(parent)

        child1 = GraphNode(
            id=child1_id,
            type=GraphNodeType.TOOL_USE,
            parent_id=parent_id,
            timestamp=datetime.now(UTC),
            data={},
        )
        graph.add_node(child1)

        child2 = GraphNode(
            id=child2_id,
            type=GraphNodeType.TOOL_USE,
            parent_id=parent_id,
            timestamp=datetime.now(UTC),
            data={},
        )
        graph.add_node(child2)

        children = graph.children(parent_id)
        assert len(children) == 2
        child_ids = {c.id for c in children}
        assert child1_id in child_ids
        assert child2_id in child_ids

    def test_ordered_nodes(self):
        """Test topological ordering of nodes."""
        from uuid import uuid4

        graph = SessionGraph()

        # Create a simple chain: A -> B -> C
        id_a = uuid4()
        id_b = uuid4()
        id_c = uuid4()

        node_c = GraphNode(
            id=id_c,
            type=GraphNodeType.MESSAGE,
            parent_id=id_b,
            timestamp=datetime.now(UTC),
            data={"order": 3},
        )
        graph.add_node(node_c)

        node_a = GraphNode(
            id=id_a,
            type=GraphNodeType.MESSAGE,
            parent_id=None,
            timestamp=datetime.now(UTC),
            data={"order": 1},
        )
        graph.add_node(node_a)

        node_b = GraphNode(
            id=id_b,
            type=GraphNodeType.MESSAGE,
            parent_id=id_a,
            timestamp=datetime.now(UTC),
            data={"order": 2},
        )
        graph.add_node(node_b)

        # Get ordered nodes
        ordered = graph.ordered_nodes()
        assert len(ordered) == 3

        # Check that parent comes before child
        pos = {node.id: i for i, node in enumerate(ordered)}
        assert pos[id_a] < pos[id_b]
        assert pos[id_b] < pos[id_c]

    def test_project_to_chat(self):
        """Test projecting graph to chat messages."""
        from uuid import uuid4

        graph = SessionGraph()

        # Add user message
        user_id = uuid4()
        user_node = GraphNode(
            id=user_id,
            type=GraphNodeType.MESSAGE,
            parent_id=None,
            timestamp=datetime.now(UTC),
            data={"role": "user", "text": "Hello"},
        )
        graph.add_node(user_node)

        # Add tool use (should be filtered out)
        tool_id = uuid4()
        tool_node = GraphNode(
            id=tool_id,
            type=GraphNodeType.TOOL_USE,
            parent_id=user_id,
            timestamp=datetime.now(UTC),
            data={"tool_name": "bash"},
        )
        graph.add_node(tool_node)

        # Add assistant message
        assistant_id = uuid4()
        assistant_node = GraphNode(
            id=assistant_id,
            type=GraphNodeType.MESSAGE,
            parent_id=tool_id,
            timestamp=datetime.now(UTC),
            data={"role": "assistant", "text": "Hi there"},
        )
        graph.add_node(assistant_node)

        # Project to chat
        chat = graph.project_to_chat()
        assert len(chat) == 2
        assert chat[0].role == "user"
        assert chat[0].content == "Hello"
        assert chat[1].role == "assistant"
        assert chat[1].content == "Hi there"


class TestReducer:
    """Tests for event reducer."""

    def test_empty_events(self):
        """Test reducing empty event list."""
        graph = reduce_events([])
        assert len(graph.nodes) == 0

    def test_assistant_streaming(self):
        """Test streaming assistant message."""
        events = [
            {
                "type": "RUN_STARTED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": "Hello"},
                "timestamp": "2024-01-01T00:00:01Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": " world"},
                "timestamp": "2024-01-01T00:00:02Z",
            },
            {
                "type": "ASSISTANT_FINAL",
                "data": {"text": "Hello world"},
                "timestamp": "2024-01-01T00:00:03Z",
            },
            {
                "type": "RUN_FINISHED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:04Z",
            },
        ]

        graph = reduce_events(events)

        # Should have one message node
        message_nodes = [n for n in graph.nodes.values() if n.type == GraphNodeType.MESSAGE]
        assert len(message_nodes) == 1

        node = message_nodes[0]
        assert node.role == "assistant"
        assert node.text == "Hello world"
        assert node.data.get("streaming") is False

    def test_tool_use(self):
        """Test tool use events."""
        events = [
            {
                "type": "RUN_STARTED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "TOOL_START",
                "data": {
                    "tool_use_id": "tool-1",
                    "name": "bash",
                    "input": {"command": "ls"},
                },
                "timestamp": "2024-01-01T00:00:01Z",
            },
            {
                "type": "TOOL_END",
                "data": {"tool_use_id": "tool-1", "status": "success"},
                "timestamp": "2024-01-01T00:00:02Z",
            },
            {
                "type": "RUN_FINISHED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:03Z",
            },
        ]

        graph = reduce_events(events)

        # Should have one tool node
        tool_nodes = [n for n in graph.nodes.values() if n.type == GraphNodeType.TOOL_USE]
        assert len(tool_nodes) == 1

        node = tool_nodes[0]
        assert node.tool_name == "bash"
        assert node.data.get("status") == "success"
        assert node.data.get("tool_use_id") == "tool-1"

    def test_reducer_determinism(self):
        """Test that reducer is deterministic: same events → same graph hash."""
        events = [
            {
                "type": "RUN_STARTED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": "Hello"},
                "timestamp": "2024-01-01T00:00:01Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": " world"},
                "timestamp": "2024-01-01T00:00:02Z",
            },
            {
                "type": "ASSISTANT_FINAL",
                "data": {"text": "Hello world"},
                "timestamp": "2024-01-01T00:00:03Z",
            },
            {
                "type": "TOOL_START",
                "data": {
                    "tool_use_id": "tool-1",
                    "name": "bash",
                    "input": {"command": "ls"},
                },
                "timestamp": "2024-01-01T00:00:04Z",
            },
            {
                "type": "TOOL_END",
                "data": {"tool_use_id": "tool-1", "status": "success"},
                "timestamp": "2024-01-01T00:00:05Z",
            },
            {
                "type": "RUN_FINISHED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:06Z",
            },
        ]

        # Reduce events multiple times
        graph1 = reduce_events(events)
        graph2 = reduce_events(events)
        graph3 = reduce_events(events)

        # All should produce same hash
        hash1 = graph1.compute_hash()
        hash2 = graph2.compute_hash()
        hash3 = graph3.compute_hash()

        assert hash1 == hash2
        assert hash2 == hash3

    def test_reducer_idempotency(self):
        """Test that reducing events twice produces same result."""
        events = [
            {
                "type": "RUN_STARTED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "ASSISTANT_FINAL",
                "data": {"text": "Response"},
                "timestamp": "2024-01-01T00:00:01Z",
            },
            {
                "type": "RUN_FINISHED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:02Z",
            },
        ]

        graph1 = reduce_events(events)
        graph2 = reduce_events(events)

        # Graphs should have same structure
        assert len(graph1.nodes) == len(graph2.nodes)
        assert graph1.compute_hash() == graph2.compute_hash()

    def test_complex_conversation(self):
        """Test a complex conversation with multiple turns."""
        events = [
            # First turn
            {
                "type": "RUN_STARTED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": "I'll help"},
                "timestamp": "2024-01-01T00:00:01Z",
            },
            {
                "type": "ASSISTANT_FINAL",
                "data": {"text": "I'll help you"},
                "timestamp": "2024-01-01T00:00:02Z",
            },
            {
                "type": "TOOL_START",
                "data": {"tool_use_id": "tool-1", "name": "bash", "input": {}},
                "timestamp": "2024-01-01T00:00:03Z",
            },
            {
                "type": "TOOL_END",
                "data": {"tool_use_id": "tool-1", "status": "success"},
                "timestamp": "2024-01-01T00:00:04Z",
            },
            {
                "type": "ASSISTANT_DELTA",
                "data": {"text": "Done"},
                "timestamp": "2024-01-01T00:00:05Z",
            },
            {
                "type": "ASSISTANT_FINAL",
                "data": {"text": "Done!"},
                "timestamp": "2024-01-01T00:00:06Z",
            },
            {
                "type": "RUN_FINISHED",
                "data": {"run_id": "run-1"},
                "timestamp": "2024-01-01T00:00:07Z",
            },
        ]

        graph = reduce_events(events)

        # Should have multiple nodes
        messages = [n for n in graph.nodes.values() if n.type == GraphNodeType.MESSAGE]
        tools = [n for n in graph.nodes.values() if n.type == GraphNodeType.TOOL_USE]

        assert len(messages) == 2  # Two assistant messages
        assert len(tools) == 1  # One tool use

        # Check chat projection
        chat = graph.project_to_chat()
        assert len(chat) == 2
        assert all(msg.role == "assistant" for msg in chat)
