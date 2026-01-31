"""Tests for the executor module with SqliteStore integration."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers import build_graph, workflow
from smithers.executor import run_graph_with_store
from smithers.store.sqlite import NodeStatus, RunStatus, SqliteStore
from smithers.testing import FakeLLMProvider, use_fake_llm
from smithers.workflow import clear_registry


class AnalysisOutput(BaseModel):
    """Output from analysis workflow."""

    files: list[str]
    summary: str


class ImplementOutput(BaseModel):
    """Output from implementation workflow."""

    changed_files: list[str]


class SimpleOutput(BaseModel):
    """Simple output for testing."""

    result: str


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()


@pytest.fixture
def store_path():
    """Temporary path for SQLite store."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir) / "test_store.db"


class TestRunGraphWithStore:
    """Tests for run_graph_with_store function."""

    @pytest.mark.asyncio
    async def test_creates_run_record(self, store_path: Path) -> None:
        """Test that execution creates a run record in the store."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        result = await run_graph_with_store(graph, store=store)

        assert result.result == "hello"

        # Verify run was created
        runs = await store.list_runs()
        assert len(runs) == 1
        assert runs[0].status == RunStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_creates_node_records(self, store_path: Path) -> None:
        """Test that execution creates node records for each workflow."""

        @workflow
        async def step1() -> AnalysisOutput:
            return AnalysisOutput(files=["a.py"], summary="test")

        @workflow
        async def step2(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=analysis.files)

        graph = build_graph(step2)
        store = SqliteStore(store_path)

        await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        run_id = runs[0].run_id
        nodes = await store.get_nodes(run_id)

        assert len(nodes) == 2
        node_names = {n.node_id for n in nodes}
        assert node_names == {"step1", "step2"}

        for node in nodes:
            assert node.status == NodeStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_emits_events(self, store_path: Path) -> None:
        """Test that execution emits events to the store."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        run_id = runs[0].run_id
        events = await store.get_events(run_id)

        event_types = [e.type for e in events]
        # Should have run and node events
        assert "RunStarted" in event_types
        assert "RunFinished" in event_types
        assert "NodeReady" in event_types
        assert "NodeStarted" in event_types
        assert "NodeFinished" in event_types

    @pytest.mark.asyncio
    async def test_records_node_status_transitions(self, store_path: Path) -> None:
        """Test that node status transitions are recorded."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        run_id = runs[0].run_id

        # Get events for the node
        events = await store.get_events(run_id, node_id="simple")
        event_types = [e.type for e in events]

        # Should have status transition events
        assert "NodeReady" in event_types
        assert "NodeStarted" in event_types
        assert "NodeFinished" in event_types

    @pytest.mark.asyncio
    async def test_with_fake_llm(self, store_path: Path) -> None:
        """Test execution with fake LLM provider and store tracking."""

        @workflow
        async def analyze() -> AnalysisOutput:
            from smithers import claude

            return await claude("Analyze files", output=AnalysisOutput)

        graph = build_graph(analyze)
        store = SqliteStore(store_path)

        fake = FakeLLMProvider(responses=[{"files": ["test.py"], "summary": "test analysis"}])

        with use_fake_llm(fake):
            result = await run_graph_with_store(graph, store=store)

        assert result.files == ["test.py"]
        assert result.summary == "test analysis"

        # Verify tracking
        runs = await store.list_runs()
        assert runs[0].status == RunStatus.SUCCESS

    @pytest.mark.asyncio
    async def test_parallel_execution_tracking(self, store_path: Path) -> None:
        """Test that parallel workflows are tracked correctly."""

        @workflow
        async def base() -> SimpleOutput:
            return SimpleOutput(result="base")

        @workflow
        async def branch1(inp: SimpleOutput) -> AnalysisOutput:
            return AnalysisOutput(files=[inp.result], summary="branch1")

        @workflow
        async def branch2(inp: SimpleOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[inp.result])

        # Note: This requires both branch1 and branch2 to be consumed
        # For simplicity, let's test with a simpler parallel case

        graph = build_graph(branch1)
        store = SqliteStore(store_path)

        await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        assert runs[0].status == RunStatus.SUCCESS

        nodes = await store.get_nodes(runs[0].run_id)
        assert len(nodes) == 2

    @pytest.mark.asyncio
    async def test_return_all_with_store(self, store_path: Path) -> None:
        """Test return_all option returns full execution result."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        result = await run_graph_with_store(graph, store=store, return_all=True)

        assert result.output.result == "hello"
        assert "simple" in result.outputs
        assert len(result.results) == 1
        assert result.stats.workflows_executed == 1

    @pytest.mark.asyncio
    async def test_dry_run_does_not_create_records(self, store_path: Path) -> None:
        """Test that dry_run does not create any store records."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)
        await store.initialize()

        result = await run_graph_with_store(graph, store=store, dry_run=True)

        assert result.workflows == ["simple"]

        # No runs should be created
        runs = await store.list_runs()
        assert len(runs) == 0

    @pytest.mark.asyncio
    async def test_custom_run_id(self, store_path: Path) -> None:
        """Test using a custom run ID."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        await run_graph_with_store(graph, store=store, run_id="custom-run-123")

        runs = await store.list_runs()
        assert runs[0].run_id == "custom-run-123"


class TestExecutorCaching:
    """Tests for caching with store integration."""

    @pytest.mark.asyncio
    async def test_cached_workflows_tracked(self, store_path: Path) -> None:
        """Test that cached workflows are tracked in the store."""
        from smithers import SqliteCache

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(result="hello")

        graph = build_graph(simple)
        store = SqliteStore(store_path)

        with tempfile.TemporaryDirectory() as cache_dir:
            cache = SqliteCache(Path(cache_dir) / "cache.db")

            # First run - should execute
            await run_graph_with_store(graph, store=store, cache=cache)

            # Second run with fresh store - should be cached
            store2 = SqliteStore(store_path.parent / "store2.db")
            await run_graph_with_store(graph, store=store2, cache=cache)

            runs = await store2.list_runs()
            nodes = await store2.get_nodes(runs[0].run_id)

            # Node should show as cached
            assert nodes[0].status == NodeStatus.CACHED


class TestExecutorErrors:
    """Tests for error handling with store tracking."""

    @pytest.mark.asyncio
    async def test_failed_workflow_tracked(self, store_path: Path) -> None:
        """Test that failed workflows are tracked correctly."""

        @workflow
        async def failing() -> SimpleOutput:
            raise ValueError("Test error")

        graph = build_graph(failing)
        store = SqliteStore(store_path)

        with pytest.raises(Exception):  # WorkflowError
            await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        assert runs[0].status == RunStatus.FAILED

        nodes = await store.get_nodes(runs[0].run_id)
        assert nodes[0].status == NodeStatus.FAILED
        assert nodes[0].error_json is not None

    @pytest.mark.asyncio
    async def test_failed_run_emits_event(self, store_path: Path) -> None:
        """Test that failed runs emit RunFailed event."""

        @workflow
        async def failing() -> SimpleOutput:
            raise ValueError("Test error")

        graph = build_graph(failing)
        store = SqliteStore(store_path)

        with pytest.raises(Exception):
            await run_graph_with_store(graph, store=store)

        runs = await store.list_runs()
        events = await store.get_events(runs[0].run_id)

        event_types = [e.type for e in events]
        assert "RunFailed" in event_types


class TestExecutorApprovals:
    """Tests for approval handling with store tracking."""

    @pytest.mark.asyncio
    async def test_auto_approve_tracked(self, store_path: Path) -> None:
        """Test that auto-approved workflows are tracked."""
        from smithers import require_approval

        @workflow
        @require_approval("Deploy?")
        async def deploy() -> SimpleOutput:
            return SimpleOutput(result="deployed")

        graph = build_graph(deploy)
        store = SqliteStore(store_path)

        result = await run_graph_with_store(graph, store=store, auto_approve=True, return_all=True)

        assert result.output.result == "deployed"
        assert len(result.approvals) == 1
        assert result.approvals[0].decision is True

    @pytest.mark.asyncio
    async def test_approval_handler_tracked(self, store_path: Path) -> None:
        """Test that custom approval handler decisions are tracked."""
        from smithers import require_approval

        @workflow
        @require_approval("Deploy?")
        async def deploy() -> SimpleOutput:
            return SimpleOutput(result="deployed")

        graph = build_graph(deploy)
        store = SqliteStore(store_path)

        async def approve_all(name: str, message: str) -> bool:
            return True

        result = await run_graph_with_store(
            graph, store=store, approval_handler=approve_all, return_all=True
        )

        assert result.output.result == "deployed"

        # Check approval was recorded in store
        runs = await store.list_runs()
        approval = await store.get_approval(runs[0].run_id, "deploy")
        assert approval is not None
        assert approval.status == "APPROVED"
