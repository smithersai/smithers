"""Tests for the implemented SqliteStore functionality.

These tests verify the actual implementation in smithers/store/sqlite.py.
"""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers.store.sqlite import (
    NodeStatus,
    RunStatus,
    SqliteStore,
)
from smithers.types import WorkflowGraph, WorkflowNode


# Define proper Pydantic models for testing
class OutputA(BaseModel):
    """Test output type A."""

    value: str


class OutputB(BaseModel):
    """Test output type B."""

    count: int


# Fixture to create a simple workflow graph for testing
@pytest.fixture
def simple_graph() -> WorkflowGraph:
    """Create a simple workflow graph for testing."""
    return WorkflowGraph(
        root="step2",
        nodes={
            "step1": WorkflowNode(
                name="step1",
                output_type=OutputA,
                dependencies=[],
            ),
            "step2": WorkflowNode(
                name="step2",
                output_type=OutputB,
                dependencies=["step1"],
            ),
        },
        edges=[("step1", "step2")],
        levels=[["step1"], ["step2"]],
    )


class TestSqliteStoreInitialization:
    """Tests for store initialization."""

    async def test_creates_database_file(self, tmp_path: Path):
        """Should create the database file on initialization."""
        db_path = tmp_path / "test.db"
        store = SqliteStore(db_path)
        await store.initialize()

        assert db_path.exists()

    async def test_creates_parent_directories(self, tmp_path: Path):
        """Should create parent directories if they don't exist."""
        db_path = tmp_path / "nested" / "dir" / "test.db"
        store = SqliteStore(db_path)
        await store.initialize()

        assert db_path.exists()

    async def test_idempotent_initialization(self, tmp_path: Path):
        """Should handle being initialized multiple times."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        await store.initialize()  # Should not raise


class TestRunManagement:
    """Tests for run creation and management."""

    async def test_create_run_from_graph(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should create a run from a workflow graph."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)

        assert run_id is not None
        run = await store.get_run(run_id)
        assert run is not None
        assert run.target_node_id == "step2"
        assert run.status == RunStatus.PLANNED

    async def test_create_run_with_custom_id(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should allow specifying a custom run ID."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph, run_id="my-custom-run")

        assert run_id == "my-custom-run"

    async def test_get_run_not_found(self, tmp_path: Path):
        """Should return None for non-existent run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run = await store.get_run("nonexistent")
        assert run is None

    async def test_update_run_status(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should update the run status."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_run_status(run_id, RunStatus.RUNNING)

        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.RUNNING

    async def test_update_run_status_with_finished(
        self, tmp_path: Path, simple_graph: WorkflowGraph
    ):
        """Should set finished_at when finished=True."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)

        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.SUCCESS
        assert run.finished_at is not None

    async def test_list_runs(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should list recent runs."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        await store.create_run(simple_graph, run_id="run1")
        await store.create_run(simple_graph, run_id="run2")
        await store.create_run(simple_graph, run_id="run3")

        runs = await store.list_runs()
        assert len(runs) == 3

    async def test_list_runs_with_status_filter(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should filter runs by status."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        await store.create_run(simple_graph, run_id="run1")
        await store.create_run(simple_graph, run_id="run2")
        await store.update_run_status("run2", RunStatus.RUNNING)

        planned = await store.list_runs(status=RunStatus.PLANNED)
        assert len(planned) == 1

        running = await store.list_runs(status=RunStatus.RUNNING)
        assert len(running) == 1


class TestNodeManagement:
    """Tests for node status tracking."""

    async def test_run_creates_nodes(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should create run_node entries when creating a run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        nodes = await store.get_nodes(run_id)

        assert len(nodes) == 2
        node_names = {n.node_id for n in nodes}
        assert node_names == {"step1", "step2"}

    async def test_get_node(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should get a specific node."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        node = await store.get_node(run_id, "step1")

        assert node is not None
        assert node.node_id == "step1"
        assert node.status == NodeStatus.PENDING

    async def test_update_node_status(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should update node status."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_node_status(run_id, "step1", NodeStatus.RUNNING)

        node = await store.get_node(run_id, "step1")
        assert node is not None
        assert node.status == NodeStatus.RUNNING
        assert node.started_at is not None

    async def test_update_node_success_with_metadata(
        self, tmp_path: Path, simple_graph: WorkflowGraph
    ):
        """Should update node with cache and output info."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_node_status(
            run_id,
            "step1",
            NodeStatus.SUCCESS,
            cache_key="cache123",
            output_hash="hash456",
        )

        node = await store.get_node(run_id, "step1")
        assert node is not None
        assert node.status == NodeStatus.SUCCESS
        assert node.cache_key == "cache123"
        assert node.output_hash == "hash456"
        assert node.finished_at is not None

    async def test_update_node_with_error(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record error information."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_node_status(
            run_id,
            "step1",
            NodeStatus.FAILED,
            error=ValueError("Something went wrong"),
        )

        node = await store.get_node(run_id, "step1")
        assert node is not None
        assert node.status == NodeStatus.FAILED
        assert node.error_json is not None
        assert "Something went wrong" in node.error_json

    async def test_update_node_error_includes_cause(
        self, tmp_path: Path, simple_graph: WorkflowGraph
    ):
        """Should serialize exception causes for better diagnostics."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        try:
            try:
                raise ValueError("inner failure")
            except ValueError as exc:
                raise RuntimeError("outer failure") from exc
        except RuntimeError as exc:
            error = exc

        await store.update_node_status(run_id, "step1", NodeStatus.FAILED, error=error)

        node = await store.get_node(run_id, "step1")
        assert node is not None
        payload = json.loads(node.error_json or "{}")
        assert payload["type"] == "RuntimeError"
        assert "outer failure" in payload["message"]
        assert payload["cause"]["type"] == "ValueError"
        assert "inner failure" in payload["cause"]["message"]

    async def test_update_node_error_empty_message_fallback(
        self, tmp_path: Path, simple_graph: WorkflowGraph
    ):
        """Should fall back to a repr when the error message is empty."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.update_node_status(run_id, "step1", NodeStatus.FAILED, error=ValueError(""))

        node = await store.get_node(run_id, "step1")
        assert node is not None
        payload = json.loads(node.error_json or "{}")
        assert payload["type"] == "ValueError"
        assert payload["message"]


class TestEventLogging:
    """Tests for the append-only event log."""

    async def test_emit_event(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should emit events to the log."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        event_id = await store.emit_event(
            run_id,
            "step1",
            "CustomEvent",
            {"message": "test"},
        )

        assert event_id > 0

    async def test_get_events(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should retrieve events for a run."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.emit_event(run_id, "step1", "EventA", {"key": "value1"})
        await store.emit_event(run_id, "step1", "EventB", {"key": "value2"})

        events = await store.get_events(run_id)
        # Note: create_run also emits a RunCreated event
        assert len(events) >= 2
        event_types = {e.type for e in events}
        assert "EventA" in event_types
        assert "EventB" in event_types

    async def test_get_events_with_node_filter(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should filter events by node ID."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.emit_event(run_id, "step1", "Event", {})
        await store.emit_event(run_id, "step2", "Event", {})
        await store.emit_event(run_id, "step1", "Event", {})

        step1_events = await store.get_events(run_id, node_id="step1")
        assert len(step1_events) == 2

    async def test_get_events_with_since_id(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should support polling with since_id."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        first_id = await store.emit_event(run_id, "step1", "First", {})
        await store.emit_event(run_id, "step1", "Second", {})
        await store.emit_event(run_id, "step1", "Third", {})

        events = await store.get_events(run_id, since_id=first_id)
        assert len(events) == 2
        assert events[0].type == "Second"
        assert events[1].type == "Third"


class TestApprovals:
    """Tests for approval management."""

    async def test_request_approval(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should create an approval request."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.request_approval(run_id, "step1", "Proceed with step1?")

        approval = await store.get_approval(run_id, "step1")
        assert approval is not None
        assert approval.prompt == "Proceed with step1?"
        assert approval.status == "PENDING"

    async def test_decide_approval_approved(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record approval."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.request_approval(run_id, "step1", "Proceed?")
        await store.decide_approval(run_id, "step1", approved=True, decided_by="user@test.com")

        approval = await store.get_approval(run_id, "step1")
        assert approval is not None
        assert approval.status == "APPROVED"
        assert approval.decided_by == "user@test.com"
        assert approval.decided_at is not None

    async def test_decide_approval_rejected(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record rejection."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.request_approval(run_id, "step1", "Proceed?")
        await store.decide_approval(run_id, "step1", approved=False)

        approval = await store.get_approval(run_id, "step1")
        assert approval is not None
        assert approval.status == "REJECTED"

    async def test_list_pending_approvals(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should list pending approvals."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        await store.request_approval(run_id, "step1", "Approve step1?")
        await store.request_approval(run_id, "step2", "Approve step2?")
        await store.decide_approval(run_id, "step1", approved=True)

        pending = await store.get_pending_approvals(run_id)
        assert len(pending) == 1
        assert pending[0].node_id == "step2"


class TestLLMCallTracking:
    """Tests for LLM call tracking."""

    async def test_record_llm_call(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record LLM call start and end."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        call_id = await store.record_llm_call_start(
            run_id,
            "step1",
            "claude-sonnet-4-20250514",
            request_json='{"prompt": "test"}',
        )

        assert call_id > 0

        await store.record_llm_call_end(
            call_id,
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.001,
            response_json='{"result": "done"}',
        )

        calls = await store.get_llm_calls(run_id)
        assert len(calls) == 1
        assert calls[0].model == "claude-sonnet-4-20250514"
        assert calls[0].input_tokens == 100
        assert calls[0].output_tokens == 50
        assert calls[0].ts_end is not None


class TestToolCallTracking:
    """Tests for tool call tracking."""

    async def test_record_tool_call(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record tool call start and end."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        call_id = await store.record_tool_call_start(
            run_id,
            "step1",
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

    async def test_record_tool_call_error(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should record tool errors."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)
        call_id = await store.record_tool_call_start(
            run_id,
            "step1",
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
        assert calls[0].error_json is not None


class TestRunStatistics:
    """Tests for run statistics."""

    async def test_get_run_stats(self, tmp_path: Path, simple_graph: WorkflowGraph):
        """Should return comprehensive run statistics."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        run_id = await store.create_run(simple_graph)

        # Update node statuses
        await store.update_node_status(run_id, "step1", NodeStatus.SUCCESS)
        await store.update_node_status(run_id, "step2", NodeStatus.CACHED)

        # Record LLM call
        call_id = await store.record_llm_call_start(run_id, "step1", "model")
        await store.record_llm_call_end(call_id, input_tokens=100, output_tokens=50)

        # Record tool call
        tool_id = await store.record_tool_call_start(run_id, "step1", "Read", "{}")
        await store.record_tool_call_end(tool_id)

        stats = await store.get_run_stats(run_id)

        assert "node_counts" in stats
        assert stats["input_tokens"] == 100
        assert stats["output_tokens"] == 50
