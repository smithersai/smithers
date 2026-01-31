"""Session graph reducer for agentd.

This module implements event sourcing for session graphs:
- Takes a stream of events
- Produces a SessionGraph (DAG of nodes)
- Provides chat projection for Chat Mode
- Deterministic: same events → same graph

Key principles:
- Event sourcing: graph is derived from events
- Immutable: nodes are never modified once created
- Deterministic: replaying events produces same graph
- Projections: graph can be projected to different views
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID


class GraphNodeType(str, Enum):
    """Types of nodes in the session graph."""

    MESSAGE = "message"  # User or assistant message
    TOOL_USE = "toolUse"  # Tool invocation
    TOOL_RESULT = "toolResult"  # Tool result (references artifact)
    CHECKPOINT = "checkpoint"  # Code snapshot
    SUBAGENT_RUN = "subagentRun"  # Subagent execution
    SKILL_RUN = "skillRun"  # Skill execution
    PROMPT_REBASE = "promptRebase"  # Prompt rebase point
    BROWSER_SNAPSHOT = "browserSnapshot"  # Captured browser state


@dataclass
class GraphNode:
    """A node in the session graph."""

    id: UUID
    type: GraphNodeType
    parent_id: UUID | None
    timestamp: datetime
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str | None:
        """Get text content from data."""
        return self.data.get("text")

    @property
    def role(self) -> str | None:
        """Get role (user/assistant) from data."""
        return self.data.get("role")

    @property
    def tool_name(self) -> str | None:
        """Get tool name from data."""
        return self.data.get("tool_name")

    @property
    def artifact_ref(self) -> str | None:
        """Get artifact reference from data."""
        return self.data.get("artifact_ref")

    def to_dict(self) -> dict[str, Any]:
        """Convert node to dictionary for serialization."""
        return {
            "id": str(self.id),
            "type": self.type.value,
            "parent_id": str(self.parent_id) if self.parent_id else None,
            "timestamp": self.timestamp.isoformat(),
            "data": self.data,
        }


@dataclass
class ChatMessage:
    """A chat message (projection from graph)."""

    id: UUID
    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime


class SessionGraph:
    """
    The session graph - a DAG of nodes derived from events.

    This graph represents the UX-level structure of a session:
    - Messages (user and assistant)
    - Tool uses and results
    - Checkpoints
    - Skills and subagents
    - Browser snapshots

    The graph is built by reducing over a stream of events.
    """

    def __init__(self) -> None:
        """Initialize an empty session graph."""
        self.nodes: dict[UUID, GraphNode] = {}
        self.root_ids: list[UUID] = []
        self._current_message_id: UUID | None = None  # Track current assistant message
        self._current_message_text: str = ""  # Accumulate streaming text
        self._pending_tool_statuses: dict[str, str] = {}  # tool_use_id -> status

    def add_node(self, node: GraphNode) -> None:
        """Add a node to the graph."""
        self.nodes[node.id] = node
        if node.parent_id is None:
            self.root_ids.append(node.id)

    def get_node(self, node_id: UUID) -> GraphNode | None:
        """Get a node by ID."""
        return self.nodes.get(node_id)

    def children(self, node_id: UUID) -> list[GraphNode]:
        """Get children of a node."""
        return [n for n in self.nodes.values() if n.parent_id == node_id]

    def ordered_nodes(self) -> list[GraphNode]:
        """Get all nodes in topological order."""
        result: list[GraphNode] = []
        visited: set[UUID] = set()

        def visit(node_id: UUID) -> None:
            if node_id in visited:
                return
            node = self.nodes.get(node_id)
            if not node:
                return
            visited.add(node_id)
            if node.parent_id:
                visit(node.parent_id)
            result.append(node)

        for node_id in self.nodes:
            visit(node_id)

        return result

    def project_to_chat(self) -> list[ChatMessage]:
        """Project graph to chat messages (for Chat Mode)."""
        messages: list[ChatMessage] = []
        for node in self.ordered_nodes():
            if node.type == GraphNodeType.MESSAGE:
                role = node.role or "assistant"
                content = node.text or ""
                messages.append(
                    ChatMessage(
                        id=node.id,
                        role=role,
                        content=content,
                        timestamp=node.timestamp,
                    )
                )
        return messages

    def compute_hash(self) -> str:
        """
        Compute a deterministic hash of the graph structure.

        This is used to verify reducer determinism: same events should
        produce the same graph hash.
        """
        # Sort nodes by ID for determinism
        sorted_nodes = sorted(self.nodes.values(), key=lambda n: str(n.id))
        # Create canonical JSON representation
        graph_data = {"nodes": [n.to_dict() for n in sorted_nodes]}
        canonical_json = json.dumps(graph_data, sort_keys=True)
        return hashlib.sha256(canonical_json.encode()).hexdigest()


def reduce_events(events: list[dict[str, Any]]) -> SessionGraph:
    """
    Reduce a list of events into a SessionGraph.

    This is the core reducer function that implements event sourcing.
    It processes events in order and builds up the graph state.

    Args:
        events: List of event dictionaries with 'type' and 'data' fields

    Returns:
        SessionGraph built from the events
    """
    graph = SessionGraph()

    # For determinism, we need to generate node IDs deterministically
    # based on event order (not random UUIDs)
    node_counter = 0

    def next_node_id() -> UUID:
        """Generate next deterministic node ID."""
        nonlocal node_counter
        node_counter += 1
        # Use a deterministic UUID based on counter
        return UUID(int=node_counter)

    for event in events:
        event_type = event.get("type", "")
        data = event.get("data", {})
        timestamp = event.get("timestamp")

        # Parse timestamp
        if isinstance(timestamp, str):
            try:
                ts = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                # Fallback to current time for malformed timestamps
                ts = datetime.now()
        elif isinstance(timestamp, datetime):
            ts = timestamp
        else:
            ts = datetime.now()

        # Process event based on type
        if event_type == "RUN_STARTED":
            # Run started - reset streaming state
            graph._current_message_id = None
            graph._current_message_text = ""

        elif event_type == "ASSISTANT_DELTA":
            # Streaming text delta
            text = data.get("text", "")
            graph._current_message_text += text

            # Create or update message node
            if graph._current_message_id is None:
                # First delta - create new message node
                node_id = next_node_id()
                graph._current_message_id = node_id
                node = GraphNode(
                    id=node_id,
                    type=GraphNodeType.MESSAGE,
                    parent_id=None,
                    timestamp=ts,
                    data={"role": "assistant", "text": text, "streaming": True},
                )
                graph.add_node(node)
            else:
                # Subsequent delta - update existing node
                node = graph.nodes.get(graph._current_message_id)
                if node:
                    node.data["text"] = graph._current_message_text

        elif event_type == "ASSISTANT_FINAL":
            # Assistant message complete
            text = data.get("text", "")
            if graph._current_message_id:
                # Update existing streaming node
                node = graph.nodes.get(graph._current_message_id)
                if node:
                    node.data["text"] = text
                    node.data["streaming"] = False
                # Reset for next message
                graph._current_message_id = None
                graph._current_message_text = ""
            else:
                # Create new node (non-streaming case)
                node_id = next_node_id()
                node = GraphNode(
                    id=node_id,
                    type=GraphNodeType.MESSAGE,
                    parent_id=None,
                    timestamp=ts,
                    data={"role": "assistant", "text": text, "streaming": False},
                )
                graph.add_node(node)

        elif event_type == "TOOL_START":
            # Tool invocation started
            node_id = next_node_id()
            tool_use_id = data.get("tool_use_id")

            # Check if we have a pending status from an out-of-order TOOL_END
            status = graph._pending_tool_statuses.pop(tool_use_id, "running") if tool_use_id else "running"

            node = GraphNode(
                id=node_id,
                type=GraphNodeType.TOOL_USE,
                parent_id=graph._current_message_id,
                timestamp=ts,
                data={
                    "tool_use_id": tool_use_id,
                    "tool_name": data.get("name"),
                    "input": data.get("input", {}),
                    "status": status,
                },
            )
            graph.add_node(node)

        elif event_type == "TOOL_END":
            # Tool completed - find the tool_use node and update it
            tool_use_id = data.get("tool_use_id")
            status = data.get("status", "success")

            # Try to find existing tool node
            found = False
            for node in graph.nodes.values():
                if (
                    node.type == GraphNodeType.TOOL_USE
                    and node.data.get("tool_use_id") == tool_use_id
                ):
                    node.data["status"] = status
                    found = True
                    break

            # If tool node doesn't exist yet, store status for when TOOL_START arrives
            if not found and tool_use_id:
                graph._pending_tool_statuses[tool_use_id] = status

        elif event_type == "SESSION_CREATED":
            # Session created - no graph nodes needed
            pass

        elif event_type == "RUN_FINISHED":
            # Run finished - finalize streaming
            graph._current_message_id = None
            graph._current_message_text = ""

    return graph
