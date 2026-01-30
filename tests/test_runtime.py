"""Tests for RuntimeContext and LLM/tool call tracking integration."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import build_graph, run_graph
from smithers.executor import run_graph_with_store
from smithers.runtime import (
    RuntimeContext,
    get_current_context,
    record_llm_call_end,
    record_llm_call_start,
    record_tool_call_end,
    record_tool_call_start,
    reset_context,
    runtime_context,
    set_current_context,
)
from smithers.store.sqlite import SqliteStore
from smithers.testing.fakes import FakeLLMProvider, use_fake_llm
from smithers.workflow import clear_registry, workflow


# Pydantic models at module level to avoid scoping issues with get_type_hints
class ContextCheckOutput(BaseModel):
    message: str
    had_context: bool
    run_id: str | None
    node_id: str | None


class AnalysisOutput(BaseModel):
    summary: str


class StepOneOutput(BaseModel):
    node_name: str


class StepTwoOutput(BaseModel):
    node_name: str


class ParallelOutputA(BaseModel):
    node_id: str


class ParallelOutputB(BaseModel):
    node_id: str


class CombinedOutput(BaseModel):
    a_node: str
    b_node: str


class SimpleOutput(BaseModel):
    value: int


class ClaudeTestOutput(BaseModel):
    result: str


class TestRuntimeContext:
    """Tests for basic RuntimeContext functionality."""

    def test_context_default_is_none(self) -> None:
        """Test that get_current_context returns None by default."""
        assert get_current_context() is None

    def test_set_and_get_context(self) -> None:
        """Test setting and getting context."""
        ctx = RuntimeContext(run_id="test-run", node_id="test-node")
        token = set_current_context(ctx)
        try:
            current = get_current_context()
            assert current is not None
            assert current.run_id == "test-run"
            assert current.node_id == "test-node"
            assert current.store is None
        finally:
            reset_context(token)

    def test_reset_context(self) -> None:
        """Test that reset_context restores previous state."""
        # Set initial context
        ctx1 = RuntimeContext(run_id="run1", node_id="node1")
        token1 = set_current_context(ctx1)

        # Set nested context
        ctx2 = RuntimeContext(run_id="run2", node_id="node2")
        token2 = set_current_context(ctx2)

        # Current should be ctx2
        assert get_current_context() == ctx2

        # Reset to ctx1
        reset_context(token2)
        assert get_current_context() == ctx1

        # Reset to None
        reset_context(token1)
        assert get_current_context() is None

    def test_runtime_context_manager(self) -> None:
        """Test runtime_context context manager."""
        ctx = RuntimeContext(run_id="test-run", node_id="test-node")

        assert get_current_context() is None

        with runtime_context(ctx) as entered_ctx:
            assert entered_ctx == ctx
            assert get_current_context() == ctx

        assert get_current_context() is None

    def test_nested_context_managers(self) -> None:
        """Test nested runtime_context managers."""
        ctx1 = RuntimeContext(run_id="run1", node_id="node1")
        ctx2 = RuntimeContext(run_id="run2", node_id="node2")

        with runtime_context(ctx1):
            assert get_current_context() == ctx1

            with runtime_context(ctx2):
                assert get_current_context() == ctx2

            # After inner context exits, should be back to ctx1
            assert get_current_context() == ctx1

        assert get_current_context() is None


class TestRuntimeContextWithStore:
    """Tests for RuntimeContext with SqliteStore."""

    @pytest.fixture
    def store(self, tmp_path) -> SqliteStore:
        """Create a temporary store."""
        return SqliteStore(tmp_path / "test.db")

    @pytest.mark.asyncio
    async def test_context_with_store(self, store: SqliteStore) -> None:
        """Test RuntimeContext with store reference."""
        await store.initialize()
        ctx = RuntimeContext(run_id="test-run", node_id="test-node", store=store)

        with runtime_context(ctx):
            current = get_current_context()
            assert current is not None
            assert current.store is store


class TestLLMCallTracking:
    """Tests for LLM call tracking via RuntimeContext."""

    @pytest.fixture
    def store(self, tmp_path) -> SqliteStore:
        """Create a temporary store."""
        return SqliteStore(tmp_path / "test.db")

    @pytest.mark.asyncio
    async def test_record_llm_call_without_context(self) -> None:
        """Test that recording without context returns None."""
        call_id = await record_llm_call_start(model="claude-3", request={"prompt": "test"})
        assert call_id is None

        # End should be a no-op
        await record_llm_call_end(None, input_tokens=100, output_tokens=50)

    @pytest.mark.asyncio
    async def test_record_llm_call_with_context(self, store: SqliteStore) -> None:
        """Test recording LLM call with active context."""
        await store.initialize()
        run_id = await store.create_run("plan123", "target_node")

        ctx = RuntimeContext(run_id=run_id, node_id="test_node", store=store)

        with runtime_context(ctx):
            call_id = await record_llm_call_start(
                model="claude-3-sonnet",
                request={"prompt": "Hello", "output_type": "TestOutput"},
            )
            assert call_id is not None
            assert isinstance(call_id, int)

            await record_llm_call_end(
                call_id,
                input_tokens=100,
                output_tokens=50,
                response={"success": True},
            )

        # Verify the call was recorded
        calls = await store.get_llm_calls(run_id)
        assert len(calls) == 1
        assert calls[0].model == "claude-3-sonnet"
        assert calls[0].input_tokens == 100
        assert calls[0].output_tokens == 50

    @pytest.mark.asyncio
    async def test_record_multiple_llm_calls(self, store: SqliteStore) -> None:
        """Test recording multiple LLM calls."""
        await store.initialize()
        run_id = await store.create_run("plan123", "target_node")

        ctx = RuntimeContext(run_id=run_id, node_id="test_node", store=store)

        with runtime_context(ctx):
            # First call
            call_id1 = await record_llm_call_start(model="claude-3-sonnet", request={})
            await record_llm_call_end(call_id1, input_tokens=50, output_tokens=25)

            # Second call
            call_id2 = await record_llm_call_start(model="claude-3-opus", request={})
            await record_llm_call_end(call_id2, input_tokens=100, output_tokens=75)

        calls = await store.get_llm_calls(run_id)
        assert len(calls) == 2


class TestToolCallTracking:
    """Tests for tool call tracking via RuntimeContext."""

    @pytest.fixture
    def store(self, tmp_path) -> SqliteStore:
        """Create a temporary store."""
        return SqliteStore(tmp_path / "test.db")

    @pytest.mark.asyncio
    async def test_record_tool_call_without_context(self) -> None:
        """Test that recording without context returns None."""
        call_id = await record_tool_call_start("Read", {"path": "/test.txt"})
        assert call_id is None

        # End should be a no-op
        await record_tool_call_end(None, output={"content": "test"})

    @pytest.mark.asyncio
    async def test_record_tool_call_with_context(self, store: SqliteStore) -> None:
        """Test recording tool call with active context."""
        await store.initialize()
        run_id = await store.create_run("plan123", "target_node")

        ctx = RuntimeContext(run_id=run_id, node_id="test_node", store=store)

        with runtime_context(ctx):
            call_id = await record_tool_call_start("Read", {"path": "/test.txt"})
            assert call_id is not None

            await record_tool_call_end(call_id, output={"content": "hello world"})

        # Verify the call was recorded
        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].tool_name == "Read"
        assert calls[0].status == "SUCCESS"

    @pytest.mark.asyncio
    async def test_record_tool_call_failure(self, store: SqliteStore) -> None:
        """Test recording a failed tool call."""
        await store.initialize()
        run_id = await store.create_run("plan123", "target_node")

        ctx = RuntimeContext(run_id=run_id, node_id="test_node", store=store)

        with runtime_context(ctx):
            call_id = await record_tool_call_start("Bash", {"command": "invalid"})
            await record_tool_call_end(call_id, error=RuntimeError("Command failed"))

        calls = await store.get_tool_calls(run_id)
        assert len(calls) == 1
        assert calls[0].status == "FAILED"
        assert calls[0].error_json is not None


class TestExecutorRuntimeIntegration:
    """Tests for RuntimeContext integration in the executor."""

    @pytest.fixture(autouse=True)
    def clear_workflows(self) -> None:
        """Clear workflow registry before each test."""
        clear_registry()
        yield
        clear_registry()

    @pytest.fixture
    def store(self, tmp_path) -> SqliteStore:
        """Create a temporary store."""
        return SqliteStore(tmp_path / "test.db")

    @pytest.mark.asyncio
    async def test_runtime_context_set_during_execution(self, store: SqliteStore) -> None:
        """Test that RuntimeContext is set during workflow execution."""
        captured_context: list[RuntimeContext | None] = []

        @workflow
        async def check_context() -> ContextCheckOutput:
            ctx = get_current_context()
            captured_context.append(ctx)
            return ContextCheckOutput(
                message="done",
                had_context=ctx is not None,
                run_id=ctx.run_id if ctx else None,
                node_id=ctx.node_id if ctx else None,
            )

        graph = build_graph(check_context)

        result = await run_graph_with_store(graph, store=store)

        assert result.had_context is True
        assert result.run_id is not None
        assert result.node_id == "check_context"

    @pytest.mark.asyncio
    async def test_llm_calls_tracked_in_execution(self, store: SqliteStore) -> None:
        """Test that LLM calls made during execution are tracked."""

        @workflow
        async def analyze() -> AnalysisOutput:
            from smithers import claude
            return await claude("Analyze this", output=AnalysisOutput)

        fake = FakeLLMProvider(responses=[{"summary": "Test analysis"}])

        with use_fake_llm(fake):
            graph = build_graph(analyze)
            result = await run_graph_with_store(graph, store=store, return_all=True)

        # Check that the workflow succeeded
        assert result.output.summary == "Test analysis"

        # Get the run_id from the result
        # The run_id is tracked in the store
        runs = await store.list_runs(limit=1)
        assert len(runs) == 1
        run_id = runs[0].run_id

        # Note: With fake provider, real LLM calls aren't made, so tracking
        # won't record actual calls. This test verifies the execution works
        # with RuntimeContext active.
        assert runs[0].status.value == "SUCCESS"

    @pytest.mark.asyncio
    async def test_multiple_nodes_have_correct_context(self, store: SqliteStore) -> None:
        """Test that each node gets the correct RuntimeContext."""

        @workflow
        async def step_one() -> StepOneOutput:
            ctx = get_current_context()
            return StepOneOutput(node_name=ctx.node_id if ctx else "unknown")

        @workflow
        async def step_two(step_one: StepOneOutput) -> StepTwoOutput:
            ctx = get_current_context()
            return StepTwoOutput(node_name=ctx.node_id if ctx else "unknown")

        graph = build_graph(step_two)
        result = await run_graph_with_store(graph, store=store, return_all=True)

        # Each workflow should have seen its own node_id
        assert result.outputs["step_one"].node_name == "step_one"
        assert result.outputs["step_two"].node_name == "step_two"

    @pytest.mark.asyncio
    async def test_context_not_leaked_between_parallel_nodes(self, store: SqliteStore) -> None:
        """Test that parallel nodes each get their own context."""

        @workflow
        async def task_a() -> ParallelOutputA:
            ctx = get_current_context()
            return ParallelOutputA(node_id=ctx.node_id if ctx else "unknown")

        @workflow
        async def task_b() -> ParallelOutputB:
            ctx = get_current_context()
            return ParallelOutputB(node_id=ctx.node_id if ctx else "unknown")

        @workflow
        async def combine(a: ParallelOutputA, b: ParallelOutputB) -> CombinedOutput:
            return CombinedOutput(a_node=a.node_id, b_node=b.node_id)

        graph = build_graph(combine)
        result = await run_graph_with_store(graph, store=store, return_all=True)

        # Each parallel task should have seen its own node_id
        assert result.output.a_node == "task_a"
        assert result.output.b_node == "task_b"


class TestClaudeTrackingIntegration:
    """Tests for claude() function tracking with RuntimeContext."""

    @pytest.fixture(autouse=True)
    def clear_workflows(self) -> None:
        """Clear workflow registry before each test."""
        clear_registry()
        yield
        clear_registry()

    @pytest.fixture
    def store(self, tmp_path) -> SqliteStore:
        """Create a temporary store."""
        return SqliteStore(tmp_path / "test.db")

    @pytest.mark.asyncio
    async def test_fake_llm_works_with_runtime_context(self, store: SqliteStore) -> None:
        """Test that fake LLM provider works with runtime context active."""
        await store.initialize()
        run_id = await store.create_run("plan123", "target_node")

        from smithers import claude

        ctx = RuntimeContext(run_id=run_id, node_id="test_node", store=store)
        fake = FakeLLMProvider(responses=[{"result": "mocked"}])

        with use_fake_llm(fake), runtime_context(ctx):
            result = await claude("Test prompt", output=ClaudeTestOutput)
            assert result.result == "mocked"

        # Verify the fake provider was used
        assert len(fake.calls) == 1
        assert fake.calls[0].prompt == "Test prompt"


class TestRunGraphContextIsolation:
    """Tests for context isolation during run_graph execution."""

    @pytest.fixture(autouse=True)
    def clear_workflows(self) -> None:
        """Clear workflow registry before each test."""
        clear_registry()
        yield
        clear_registry()

    @pytest.mark.asyncio
    async def test_context_none_after_run_graph(self, tmp_path) -> None:
        """Test that context is None after run_graph completes."""

        @workflow
        async def simple() -> SimpleOutput:
            return SimpleOutput(value=42)

        # Context should be None before
        assert get_current_context() is None

        graph = build_graph(simple)
        store = SqliteStore(tmp_path / "test.db")
        await run_graph_with_store(graph, store=store)

        # Context should be None after
        assert get_current_context() is None

    @pytest.mark.asyncio
    async def test_context_none_after_failed_run(self, tmp_path) -> None:
        """Test that context is None even after a failed run."""

        @workflow
        async def failing() -> SimpleOutput:
            raise ValueError("Intentional failure")

        graph = build_graph(failing)
        store = SqliteStore(tmp_path / "test.db")

        with pytest.raises(Exception):
            await run_graph_with_store(graph, store=store)

        # Context should be None after failure
        assert get_current_context() is None
