"""Tests for SqliteStore - the execution ledger.

The SqliteStore is the system of record for all execution state as specified in ARCHITECTURE.md:
- Runs (execution of a workflow graph)
- Run nodes (status of each node within a run)
- Events (append-only log for visibility)
- Approvals (human-in-the-loop gates)
- LLM calls (API call tracking)
- Tool calls (tool invocation tracking)
"""

from pathlib import Path

from pydantic import BaseModel

from smithers import build_graph, workflow
from smithers.store.sqlite import (
    NodeStatus,
    RunStatus,
    SqliteStore,
)


# Test output model
class TestOutput(BaseModel):
    value: str


# Create a simple workflow for testing
@workflow
async def simple_workflow() -> TestOutput:
    return TestOutput(value="test")


class TestRunManagement:
    """Tests for run creation and management."""

    async def test_create_run(self, tmp_path: Path):
        """Should create a new run with PLANNED status."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        assert run_id is not None
        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.PLANNED
        assert run.target_node_id == "simple_workflow"

    async def test_create_run_with_custom_id(self, tmp_path: Path):
        """Should allow specifying a custom run ID."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph, run_id="custom-run-id")

        assert run_id == "custom-run-id"
        run = await store.get_run("custom-run-id")
        assert run is not None

    async def test_get_run_not_found(self, tmp_path: Path):
        """Should return None for non-existent run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run = await store.get_run("non-existent")
        assert run is None

    async def test_update_run_status(self, tmp_path: Path):
        """Should update run status."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)
        await store.update_run_status(run_id, RunStatus.RUNNING)

        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.RUNNING

    async def test_update_run_status_finished(self, tmp_path: Path):
        """Should set finished_at when finished=True."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)
        await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)

        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.SUCCESS
        assert run.finished_at is not None

    async def test_list_runs(self, tmp_path: Path):
        """Should list runs with optional status filter."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)

        # Create multiple runs
        await store.create_run(graph)
        run2 = await store.create_run(graph)
        await store.create_run(graph)

        # Update one to RUNNING
        await store.update_run_status(run2, RunStatus.RUNNING)

        # List all runs
        all_runs = await store.list_runs()
        assert len(all_runs) == 3

        # Filter by status
        planned_runs = await store.list_runs(status=RunStatus.PLANNED)
        assert len(planned_runs) == 2

        running_runs = await store.list_runs(status=RunStatus.RUNNING)
        assert len(running_runs) == 1


class TestNodeManagement:
    """Tests for run node status tracking."""

    async def test_nodes_created_with_run(self, tmp_path: Path):
        """Should create node records when creating a run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        nodes = await store.get_nodes(run_id)
        assert len(nodes) == 1
        assert nodes[0].node_id == "simple_workflow"
        assert nodes[0].status == NodeStatus.PENDING

    async def test_get_node(self, tmp_path: Path):
        """Should get a specific node."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        node = await store.get_node(run_id, "simple_workflow")
        assert node is not None
        assert node.status == NodeStatus.PENDING

    async def test_update_node_status(self, tmp_path: Path):
        """Should update node status with metadata."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.update_node_status(
            run_id,
            "simple_workflow",
            NodeStatus.SUCCESS,
            cache_key="cache123",
            output_hash="output456",
        )

        node = await store.get_node(run_id, "simple_workflow")
        assert node is not None
        assert node.status == NodeStatus.SUCCESS
        assert node.cache_key == "cache123"
        assert node.output_hash == "output456"

    async def test_update_node_running_sets_started_at(self, tmp_path: Path):
        """Should set started_at when status is RUNNING."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.update_node_status(
            run_id,
            "simple_workflow",
            NodeStatus.RUNNING,
        )

        node = await store.get_node(run_id, "simple_workflow")
        assert node is not None
        assert node.started_at is not None

    async def test_update_node_with_error(self, tmp_path: Path):
        """Should record error information."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.update_node_status(
            run_id,
            "simple_workflow",
            NodeStatus.FAILED,
            error=ValueError("Something went wrong"),
        )

        node = await store.get_node(run_id, "simple_workflow")
        assert node is not None
        assert node.status == NodeStatus.FAILED
        assert node.error_json is not None
        assert "Something went wrong" in node.error_json


class TestEventManagement:
    """Tests for the append-only event log."""

    async def test_emit_event(self, tmp_path: Path):
        """Should emit events to the log."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        event_id = await store.emit_event(
            run_id,
            "simple_workflow",
            "CustomEvent",
            {"message": "test"},
        )

        assert event_id > 0

    async def test_get_events(self, tmp_path: Path):
        """Should retrieve events for a run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        # Run creation emits an event, plus we add two more
        await store.emit_event(run_id, "simple_workflow", "NodeStarted", {})
        await store.emit_event(run_id, "simple_workflow", "NodeFinished", {"duration_ms": 100})

        events = await store.get_events(run_id)
        # Should have RunCreated + NodeStarted + NodeFinished
        assert len(events) >= 2

        # Find our custom events
        node_events = [e for e in events if e.type in ("NodeStarted", "NodeFinished")]
        assert len(node_events) == 2

    async def test_get_events_filtered_by_node(self, tmp_path: Path):
        """Should filter events by node ID."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.emit_event(run_id, "node1", "NodeStarted", {})
        await store.emit_event(run_id, "node2", "NodeStarted", {})
        await store.emit_event(run_id, "node1", "NodeFinished", {})

        events = await store.get_events(run_id, node_id="node1")
        assert len(events) == 2
        assert all(e.node_id == "node1" for e in events)

    async def test_get_events_filtered_by_type(self, tmp_path: Path):
        """Should filter events by event type."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.emit_event(run_id, "node1", "NodeStarted", {})
        await store.emit_event(run_id, "node1", "CacheHit", {})
        await store.emit_event(run_id, "node2", "NodeStarted", {})

        events = await store.get_events(run_id, event_type="NodeStarted")
        assert len(events) == 2

    async def test_get_events_since_id(self, tmp_path: Path):
        """Should support polling with since_id."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        first_id = await store.emit_event(run_id, "node1", "NodeStarted", {})
        await store.emit_event(run_id, "node1", "NodeFinished", {})
        await store.emit_event(run_id, "node2", "NodeStarted", {})

        # Get events after the first one
        events = await store.get_events(run_id, since_id=first_id)
        assert len(events) == 2
        assert events[0].type == "NodeFinished"


class TestSessionEvents:
    """Tests for session event persistence."""

    async def test_append_session_event(self, tmp_path: Path):
        """Should append events to session log."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        session_id = "session-123"
        event_id = await store.append_session_event(
            session_id,
            "assistant.delta",
            {"text": "Hello"},
        )

        assert event_id > 0

    async def test_get_session_events(self, tmp_path: Path):
        """Should retrieve events for a session."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        session_id = "session-123"
        await store.append_session_event(session_id, "run.started", {"run_id": "run-1"})
        await store.append_session_event(session_id, "assistant.delta", {"text": "Hi"})
        await store.append_session_event(session_id, "run.finished", {"run_id": "run-1"})

        events = await store.get_session_events(session_id)
        assert len(events) == 3
        assert events[0].type == "run.started"
        assert events[1].type == "assistant.delta"
        assert events[2].type == "run.finished"

    async def test_get_session_events_filtered_by_type(self, tmp_path: Path):
        """Should filter session events by type."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        session_id = "session-123"
        await store.append_session_event(session_id, "assistant.delta", {"text": "Hello"})
        await store.append_session_event(session_id, "tool.start", {"tool": "bash"})
        await store.append_session_event(session_id, "assistant.delta", {"text": "World"})

        events = await store.get_session_events(session_id, event_type="assistant.delta")
        assert len(events) == 2
        assert all(e.type == "assistant.delta" for e in events)

    async def test_get_session_events_since_id(self, tmp_path: Path):
        """Should support polling with since_id."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        session_id = "session-123"
        first_id = await store.append_session_event(session_id, "run.started", {})
        await store.append_session_event(session_id, "assistant.delta", {"text": "Hi"})
        await store.append_session_event(session_id, "run.finished", {})

        # Get events after the first one
        events = await store.get_session_events(session_id, since_id=first_id)
        assert len(events) == 2
        assert events[0].type == "assistant.delta"

    async def test_get_session_events_limit(self, tmp_path: Path):
        """Should respect limit parameter."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        session_id = "session-123"
        for i in range(5):
            await store.append_session_event(session_id, "assistant.delta", {"text": f"msg{i}"})

        events = await store.get_session_events(session_id, limit=3)
        assert len(events) == 3

    async def test_multiple_sessions_isolated(self, tmp_path: Path):
        """Should isolate events between sessions."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        await store.append_session_event("session-1", "assistant.delta", {"text": "A"})
        await store.append_session_event("session-2", "assistant.delta", {"text": "B"})
        await store.append_session_event("session-1", "assistant.delta", {"text": "C"})

        events_1 = await store.get_session_events("session-1")
        events_2 = await store.get_session_events("session-2")

        assert len(events_1) == 2
        assert len(events_2) == 1


class TestApprovalManagement:
    """Tests for human-in-the-loop approval gates."""

    async def test_request_approval(self, tmp_path: Path):
        """Should create an approval request."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "deploy", "Deploy to production?")

        approval = await store.get_approval(run_id, "deploy")
        assert approval is not None
        assert approval.prompt == "Deploy to production?"
        assert approval.status == "PENDING"

    async def test_decide_approval_approved(self, tmp_path: Path):
        """Should record approval decision."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "deploy", "Deploy?")
        await store.decide_approval(run_id, "deploy", approved=True, decided_by="user@example.com")

        approval = await store.get_approval(run_id, "deploy")
        assert approval is not None
        assert approval.status == "APPROVED"
        assert approval.decided_by == "user@example.com"
        assert approval.decided_at is not None

    async def test_decide_approval_rejected(self, tmp_path: Path):
        """Should record rejection."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "deploy", "Deploy?")
        await store.decide_approval(run_id, "deploy", approved=False)

        approval = await store.get_approval(run_id, "deploy")
        assert approval is not None
        assert approval.status == "REJECTED"

    async def test_get_pending_approvals(self, tmp_path: Path):
        """Should get pending approvals for a run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "node1", "Approve node1?")
        await store.request_approval(run_id, "node2", "Approve node2?")
        await store.decide_approval(run_id, "node1", approved=True)

        pending = await store.get_pending_approvals(run_id)
        assert len(pending) == 1
        assert pending[0].node_id == "node2"


class TestLLMCallTracking:
    """Tests for LLM API call tracking."""

    async def test_record_llm_call(self, tmp_path: Path):
        """Should record LLM call start and end."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        call_id = await store.record_llm_call_start(
            run_id,
            "simple_workflow",
            "claude-sonnet-4-20250514",
            request_json='{"prompt": "hello"}',
        )

        assert call_id > 0

        await store.record_llm_call_end(
            call_id,
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.0015,
            response_json='{"result": "world"}',
        )

        calls = await store.get_llm_calls(run_id)
        assert len(calls) == 1
        assert calls[0].model == "claude-sonnet-4-20250514"
        assert calls[0].input_tokens == 100
        assert calls[0].output_tokens == 50
        assert calls[0].cost_usd == 0.0015

    async def test_get_llm_calls_filtered_by_node(self, tmp_path: Path):
        """Should filter LLM calls by node."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        await store.record_llm_call_start(run_id, "node1", "model")
        await store.record_llm_call_start(run_id, "node2", "model")

        node1_calls = await store.get_llm_calls(run_id, node_id="node1")
        assert len(node1_calls) == 1


class TestToolCallTracking:
    """Tests for tool invocation tracking."""

    async def test_record_tool_call(self, tmp_path: Path):
        """Should record tool call start and end."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        call_id = await store.record_tool_call_start(
            run_id,
            "simple_workflow",
            "Read",
            '{"path": "/tmp/test.txt"}',
        )

        assert call_id > 0

        await store.record_tool_call_end(
            call_id,
            output_json='{"content": "hello"}',
        )

        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].tool_name == "Read"
        assert calls[0].status == "SUCCESS"

    async def test_record_tool_call_error(self, tmp_path: Path):
        """Should record tool errors."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        call_id = await store.record_tool_call_start(
            run_id,
            "simple_workflow",
            "Read",
            '{"path": "/nonexistent"}',
        )

        await store.record_tool_call_end(
            call_id,
            error_json='{"error": "File not found"}',
        )

        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].status == "FAILED"
        assert "File not found" in (calls[0].error_json or "")


class TestStatistics:
    """Tests for run statistics."""

    async def test_get_run_stats(self, tmp_path: Path):
        """Should return run statistics."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)

        # Update node status
        await store.update_node_status(run_id, "simple_workflow", NodeStatus.SUCCESS)

        # Record LLM call
        call_id = await store.record_llm_call_start(run_id, "simple_workflow", "model")
        await store.record_llm_call_end(call_id, input_tokens=100, output_tokens=50)

        # Record tool call
        tool_id = await store.record_tool_call_start(run_id, "simple_workflow", "Read", "{}")
        await store.record_tool_call_end(tool_id, output_json="{}")

        stats = await store.get_run_stats(run_id)

        assert "SUCCESS" in stats["node_counts"]
        assert stats["input_tokens"] == 100
        assert stats["output_tokens"] == 50
        assert "SUCCESS" in stats["tool_counts"]


class TestInitialization:
    """Tests for store initialization."""

    async def test_creates_parent_directories(self, tmp_path: Path):
        """Should create parent directories if needed."""
        db_path = tmp_path / "nested" / "dir" / "store.db"
        store = SqliteStore(db_path)
        await store.initialize()

        assert db_path.parent.exists()

    async def test_idempotent_initialization(self, tmp_path: Path):
        """Should handle multiple initializations."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        await store.initialize()  # Should not raise

    async def test_auto_initialize_on_operations(self, tmp_path: Path):
        """Should auto-initialize when performing operations."""
        store = SqliteStore(tmp_path / "test.db")
        # Don't call initialize explicitly

        graph = build_graph(simple_workflow)
        run_id = await store.create_run(graph)
        assert run_id is not None
