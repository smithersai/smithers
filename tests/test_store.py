"""Tests for SqliteStore."""

from pathlib import Path

from pydantic import BaseModel

from smithers.graph import build_graph
from smithers.store import SqliteStore
from smithers.store.sqlite import (
    NodeStatus,
    RunStatus,
)
from smithers.workflow import workflow


class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    count: int


class TestSqliteStoreBasic:
    """Basic tests for SqliteStore."""

    async def test_initialize_creates_tables(self, tmp_path: Path) -> None:
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        assert store._initialized

    async def test_can_initialize_multiple_times(self, tmp_path: Path) -> None:
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        await store.initialize()  # Should not raise
        assert store._initialized


class TestRunManagement:
    """Tests for run creation and management."""

    async def test_create_run(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        assert run_id is not None
        assert len(run_id) > 0

    async def test_create_run_with_custom_id(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph, run_id="custom-run-id")

        assert run_id == "custom-run-id"

    async def test_get_run(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        run = await store.get_run(run_id)
        assert run is not None
        assert run.run_id == run_id
        assert run.status == RunStatus.PLANNED
        assert run.target_node_id == "simple"

    async def test_get_run_not_found(self, tmp_path: Path) -> None:
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        run = await store.get_run("nonexistent")
        assert run is None

    async def test_update_run_status(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.update_run_status(run_id, RunStatus.RUNNING)
        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.RUNNING

    async def test_update_run_status_finished(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)
        run = await store.get_run(run_id)
        assert run is not None
        assert run.status == RunStatus.SUCCESS
        assert run.finished_at is not None

    async def test_list_runs(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)

        await store.create_run(graph, run_id="run-1")
        await store.create_run(graph, run_id="run-2")
        await store.create_run(graph, run_id="run-3")

        runs = await store.list_runs()
        assert len(runs) == 3


class TestNodeStatus:
    """Tests for node status tracking."""

    async def test_get_nodes(self, tmp_path: Path) -> None:
        @workflow
        async def step1() -> OutputA:
            return OutputA(value="test")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(count=1)

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(step2)
        run_id = await store.create_run(graph)

        nodes = await store.get_nodes(run_id)
        assert len(nodes) == 2
        node_ids = {n.node_id for n in nodes}
        assert "step1" in node_ids
        assert "step2" in node_ids

    async def test_get_node(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        node = await store.get_node(run_id, "simple")
        assert node is not None
        assert node.node_id == "simple"
        assert node.status == NodeStatus.PENDING

    async def test_update_node_status_running(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.update_node_status(run_id, "simple", NodeStatus.RUNNING)
        node = await store.get_node(run_id, "simple")
        assert node is not None
        assert node.status == NodeStatus.RUNNING
        assert node.started_at is not None

    async def test_update_node_status_success(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.update_node_status(run_id, "simple", NodeStatus.RUNNING)
        await store.update_node_status(run_id, "simple", NodeStatus.SUCCESS, cache_key="abc123")
        node = await store.get_node(run_id, "simple")
        assert node is not None
        assert node.status == NodeStatus.SUCCESS
        assert node.finished_at is not None
        assert node.cache_key == "abc123"

    async def test_update_node_status_with_error(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        error = ValueError("Test error")
        await store.update_node_status(run_id, "simple", NodeStatus.FAILED, error=error)
        node = await store.get_node(run_id, "simple")
        assert node is not None
        assert node.status == NodeStatus.FAILED
        assert node.error_json is not None
        assert "ValueError" in node.error_json


class TestEvents:
    """Tests for event logging."""

    async def test_emit_event(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        event_id = await store.emit_event(run_id, "simple", "CustomEvent", {"key": "value"})
        assert event_id > 0

    async def test_get_events(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        # RunCreated event is emitted automatically
        events = await store.get_events(run_id)
        assert len(events) >= 1
        assert any(e.type == "RunCreated" for e in events)

    async def test_get_events_filtered_by_node(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.emit_event(run_id, "simple", "NodeEvent", {"x": 1})
        await store.emit_event(run_id, None, "RunEvent", {"y": 2})

        node_events = await store.get_events(run_id, node_id="simple")
        assert len(node_events) == 1
        assert node_events[0].type == "NodeEvent"

    async def test_get_events_filtered_by_type(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.emit_event(run_id, None, "TypeA", {})
        await store.emit_event(run_id, None, "TypeB", {})

        type_a_events = await store.get_events(run_id, event_type="TypeA")
        assert len(type_a_events) == 1
        assert type_a_events[0].type == "TypeA"

    async def test_get_events_since_id(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        id1 = await store.emit_event(run_id, None, "Event1", {})
        await store.emit_event(run_id, None, "Event2", {})

        events = await store.get_events(run_id, since_id=id1)
        assert len(events) == 1
        assert events[0].type == "Event2"


class TestApprovals:
    """Tests for approval management."""

    async def test_request_approval(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "simple", "Please approve")

        approval = await store.get_approval(run_id, "simple")
        assert approval is not None
        assert approval.prompt == "Please approve"
        assert approval.status == "PENDING"

    async def test_decide_approval_approved(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "simple", "Please approve")
        await store.decide_approval(run_id, "simple", True, decided_by="user@test.com")

        approval = await store.get_approval(run_id, "simple")
        assert approval is not None
        assert approval.status == "APPROVED"
        assert approval.decided_by == "user@test.com"
        assert approval.decided_at is not None

    async def test_decide_approval_rejected(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "simple", "Please approve")
        await store.decide_approval(run_id, "simple", False)

        approval = await store.get_approval(run_id, "simple")
        assert approval is not None
        assert approval.status == "REJECTED"

    async def test_get_pending_approvals(self, tmp_path: Path) -> None:
        @workflow
        async def step1() -> OutputA:
            return OutputA(value="test")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(count=1)

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(step2)
        run_id = await store.create_run(graph)

        await store.request_approval(run_id, "step1", "Approve step1")
        await store.request_approval(run_id, "step2", "Approve step2")
        await store.decide_approval(run_id, "step1", True)

        pending = await store.get_pending_approvals(run_id)
        assert len(pending) == 1
        assert pending[0].node_id == "step2"


class TestLLMCallTracking:
    """Tests for LLM call tracking."""

    async def test_record_llm_call(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        call_id = await store.record_llm_call_start(
            run_id, "simple", "claude-3-opus", request_json='{"prompt": "test"}'
        )
        assert call_id > 0

        await store.record_llm_call_end(
            call_id,
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.01,
            response_json='{"result": "ok"}',
        )

        calls = await store.get_llm_calls(run_id)
        assert len(calls) == 1
        assert calls[0].model == "claude-3-opus"
        assert calls[0].input_tokens == 100
        assert calls[0].output_tokens == 50
        assert calls[0].ts_end is not None


class TestToolCallTracking:
    """Tests for tool call tracking."""

    async def test_record_tool_call_success(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        tool_call_id = await store.record_tool_call_start(
            run_id, "simple", "Read", '{"path": "/test.py"}'
        )
        assert tool_call_id > 0

        await store.record_tool_call_end(tool_call_id, output_json='{"content": "print(1)"}')

        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].tool_name == "Read"
        assert calls[0].status == "SUCCESS"

    async def test_record_tool_call_failure(self, tmp_path: Path) -> None:
        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(simple)
        run_id = await store.create_run(graph)

        tool_call_id = await store.record_tool_call_start(
            run_id, "simple", "Read", '{"path": "/missing.py"}'
        )

        await store.record_tool_call_end(tool_call_id, error_json='{"error": "File not found"}')

        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].status == "FAILED"
        assert calls[0].error_json is not None


class TestStatistics:
    """Tests for run statistics."""

    async def test_get_run_stats(self, tmp_path: Path) -> None:
        @workflow
        async def step1() -> OutputA:
            return OutputA(value="test")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(count=1)

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(step2)
        run_id = await store.create_run(graph)

        await store.update_node_status(run_id, "step1", NodeStatus.SUCCESS)
        await store.update_node_status(run_id, "step2", NodeStatus.RUNNING)

        call_id = await store.record_llm_call_start(run_id, "step1", "claude-3-opus")
        await store.record_llm_call_end(call_id, input_tokens=100, output_tokens=50)

        stats = await store.get_run_stats(run_id)
        assert "node_counts" in stats
        assert stats["input_tokens"] == 100
        assert stats["output_tokens"] == 50
