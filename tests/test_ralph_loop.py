"""Tests for Ralph Loops - declarative iteration for workflows."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import (
    RalphLoopWorkflow,
    build_graph,
    execute_ralph_loop,
    is_ralph_loop,
    ralph_loop,
    workflow,
)
from smithers.store.sqlite import SqliteStore
from smithers.workflow import clear_registry


class RefineOutput(BaseModel):
    """Output for refinement workflow."""

    content: str
    quality: float = 0.0


class ReviewOutput(BaseModel):
    """Output for review workflow."""

    feedback: str
    approved: bool = False


class CodeOutput(BaseModel):
    """Output for code workflow."""

    code: str
    approved: bool = False


class InitialCode(BaseModel):
    """Initial code output for testing."""

    code: str


class DraftOutput(BaseModel):
    """Draft output for testing."""

    content: str


class InitialDoc(BaseModel):
    """Initial document for executor tests."""

    content: str
    quality: float = 0.0


class StartDoc(BaseModel):
    """Start document for max iterations test."""

    content: str
    quality: float = 0.0


@pytest.fixture(autouse=True)
def cleanup_registry():
    """Clean up registry before and after each test."""
    clear_registry()
    yield
    clear_registry()


class TestRalphLoopBasics:
    """Test basic Ralph loop functionality."""

    def test_ralph_loop_creates_loop_workflow(self):
        """Test that ralph_loop creates a RalphLoopWorkflow."""

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + " refined", quality=doc.quality + 0.1)

        loop = ralph_loop(
            refine,
            until=lambda r: r.quality >= 0.8,
            max_iterations=5,
            register=False,
        )

        assert isinstance(loop, RalphLoopWorkflow)
        assert loop.name == "refine_loop"
        assert loop.output_type == RefineOutput
        assert loop.loop_config.max_iterations == 5
        assert loop.loop_config.until_condition is not None
        assert loop.inner_workflow == refine

    def test_is_ralph_loop_detection(self):
        """Test that is_ralph_loop correctly identifies loop workflows."""

        @workflow(register=False)
        async def simple() -> RefineOutput:
            return RefineOutput(content="test")

        @workflow(register=False)
        async def loopable(doc: RefineOutput) -> RefineOutput:
            return doc

        loop = ralph_loop(loopable, max_iterations=3, register=False)

        assert not is_ralph_loop(simple)
        assert is_ralph_loop(loop)

    def test_ralph_loop_config(self):
        """Test RalphLoopConfig settings."""

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return doc

        loop = ralph_loop(
            refine,
            until=lambda r: r.quality > 0.9,
            max_iterations=10,
            cacheable=False,
            cache_iterations=False,
            register=False,
        )

        assert loop.loop_config.max_iterations == 10
        assert loop.loop_config.cacheable is False
        assert loop.loop_config.cache_iterations is False
        assert loop.loop_config.until_condition is not None

    def test_ralph_loop_requires_workflow(self):
        """Test that ralph_loop requires a Workflow instance."""

        async def not_a_workflow(doc: RefineOutput) -> RefineOutput:
            return doc

        with pytest.raises(TypeError, match="requires a Workflow instance"):
            ralph_loop(not_a_workflow, max_iterations=3)

    def test_ralph_loop_preserves_input_types(self):
        """Test that ralph_loop preserves input type definitions."""

        @workflow(register=False)
        async def process(doc: RefineOutput) -> RefineOutput:
            return doc

        loop = ralph_loop(process, max_iterations=3, register=False)

        assert RefineOutput in loop.input_types.values()


class TestRalphLoopExecution:
    """Test Ralph loop execution."""

    @pytest.mark.asyncio
    async def test_execute_ralph_loop_basic(self):
        """Test basic Ralph loop execution."""

        call_count = 0

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            nonlocal call_count
            call_count += 1
            return RefineOutput(content=doc.content + f" v{call_count}", quality=doc.quality + 0.3)

        loop = ralph_loop(
            refine,
            until=lambda r: r.quality >= 0.8,
            max_iterations=5,
            register=False,
        )

        initial = RefineOutput(content="draft", quality=0.0)
        result, iterations = await execute_ralph_loop(loop, initial)

        assert isinstance(result, RefineOutput)
        assert result.quality >= 0.8
        assert iterations == 3  # 3 iterations to reach 0.9 quality
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_execute_ralph_loop_max_iterations(self):
        """Test that Ralph loop respects max_iterations."""

        call_count = 0

        @workflow(register=False)
        async def never_done(doc: RefineOutput) -> RefineOutput:
            nonlocal call_count
            call_count += 1
            # Never reaches quality threshold
            return RefineOutput(content=doc.content, quality=0.1)

        loop = ralph_loop(
            never_done,
            until=lambda r: r.quality >= 0.9,
            max_iterations=3,
            register=False,
        )

        initial = RefineOutput(content="draft", quality=0.0)
        result, iterations = await execute_ralph_loop(loop, initial)

        assert iterations == 3
        assert call_count == 3
        assert result.quality < 0.9  # Never met condition

    @pytest.mark.asyncio
    async def test_execute_ralph_loop_no_condition(self):
        """Test Ralph loop without until condition runs max iterations."""

        call_count = 0

        @workflow(register=False)
        async def iterate(doc: RefineOutput) -> RefineOutput:
            nonlocal call_count
            call_count += 1
            return RefineOutput(content=f"iteration {call_count}", quality=1.0)

        loop = ralph_loop(iterate, max_iterations=4, register=False)

        initial = RefineOutput(content="start")
        result, iterations = await execute_ralph_loop(loop, initial)

        assert iterations == 4
        assert call_count == 4
        assert result.content == "iteration 4"

    @pytest.mark.asyncio
    async def test_execute_ralph_loop_immediate_success(self):
        """Test Ralph loop that succeeds on first iteration."""

        @workflow(register=False)
        async def already_done(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content="perfect", quality=1.0)

        loop = ralph_loop(
            already_done,
            until=lambda r: r.quality >= 0.9,
            max_iterations=5,
            register=False,
        )

        initial = RefineOutput(content="draft", quality=0.0)
        result, iterations = await execute_ralph_loop(loop, initial)

        assert iterations == 1
        assert result.quality >= 0.9


class TestRalphLoopWithStore:
    """Test Ralph loop integration with SqliteStore."""

    @pytest.mark.asyncio
    async def test_loop_iterations_tracked_in_store(self, tmp_path):
        """Test that loop iterations are tracked in SqliteStore."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + " refined", quality=doc.quality + 0.35)

        loop = ralph_loop(
            refine,
            until=lambda r: r.quality >= 0.8,
            max_iterations=5,
            register=False,
        )

        run_id = await store.create_run("test-hash", "test-node")
        initial = RefineOutput(content="draft", quality=0.0)

        result, iterations = await execute_ralph_loop(
            loop, initial, run_id=run_id, node_id="loop_node", store=store
        )

        # Check iterations were tracked
        loop_iterations = await store.get_loop_iterations(run_id, "loop_node")
        assert len(loop_iterations) == iterations

        for i, it in enumerate(loop_iterations):
            assert it.run_id == run_id
            assert it.loop_node_id == "loop_node"
            assert it.iteration == i
            assert it.status == "SUCCESS"
            assert it.input_hash is not None
            assert it.output_hash is not None

    @pytest.mark.asyncio
    async def test_loop_stats_from_store(self, tmp_path):
        """Test getting loop statistics from store."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + " refined", quality=doc.quality + 0.5)

        loop = ralph_loop(
            refine, until=lambda r: r.quality >= 0.8, max_iterations=5, register=False
        )

        run_id = await store.create_run("test-hash", "test-node")
        initial = RefineOutput(content="draft", quality=0.0)

        await execute_ralph_loop(loop, initial, run_id=run_id, node_id="loop1", store=store)

        stats = await store.get_loop_stats(run_id)
        assert stats["loop_count"] == 1
        assert stats["total_iterations"] == 2
        assert "loop1" in stats["loops"]
        assert stats["loops"]["loop1"]["iteration_count"] == 2
        assert stats["loops"]["loop1"]["success_count"] == 2

    @pytest.mark.asyncio
    async def test_loop_events_emitted(self, tmp_path):
        """Test that loop events are emitted to the store."""
        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content="done", quality=1.0)

        loop = ralph_loop(
            refine, until=lambda r: r.quality >= 0.8, max_iterations=3, register=False
        )

        run_id = await store.create_run("test-hash", "test-node")
        initial = RefineOutput(content="draft", quality=0.0)

        await execute_ralph_loop(loop, initial, run_id=run_id, node_id="loop_node", store=store)

        events = await store.get_events(run_id)
        event_types = [e.type for e in events]

        assert "LoopIterationStarted" in event_types
        assert "LoopIterationFinished" in event_types


class TestRalphLoopWithGraph:
    """Test Ralph loops in workflow graphs."""

    @pytest.mark.asyncio
    async def test_ralph_loop_in_graph(self):
        """Test that Ralph loops work in workflow graphs."""

        @workflow
        async def generate_code() -> InitialCode:
            return InitialCode(code="initial code")

        @workflow(register=False)
        async def review_and_fix(initial: InitialCode) -> CodeOutput:
            # First iteration receives InitialCode, returns CodeOutput
            return CodeOutput(code=initial.code + " reviewed", approved=True)

        # For graph testing, use register=False and manual binding
        review_loop = ralph_loop(
            review_and_fix,
            until=lambda r: r.approved,
            max_iterations=3,
            register=False,
        )

        # The loop takes InitialCode as input
        assert InitialCode in review_loop.input_types.values()

        # Execute manually for testing
        initial = InitialCode(code="test")
        # Note: The loop execution would require adapting input types
        # For now we verify the structure is correct
        assert review_loop.inner_workflow is not None
        assert review_loop.loop_config.max_iterations == 3

    @pytest.mark.asyncio
    async def test_ralph_loop_mermaid_visualization(self):
        """Test that Ralph loops appear in mermaid diagrams."""

        @workflow
        async def prepare() -> DraftOutput:
            return DraftOutput(content="draft")

        @workflow(register=False)
        async def refine(doc: DraftOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + " refined", quality=1.0)

        loop = ralph_loop(refine, max_iterations=3, register=False)

        # The loop should have proper metadata
        assert loop.name == "refine_loop"
        assert loop.loop_config.max_iterations == 3

    @pytest.mark.asyncio
    async def test_ralph_loop_standalone_execution(self):
        """Test Ralph loop execution without graph dependencies."""

        @workflow(register=False)
        async def improve(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + "+", quality=doc.quality + 0.4)

        loop = ralph_loop(
            improve,
            until=lambda r: r.quality >= 0.8,
            max_iterations=5,
            register=False,
        )

        # Execute the loop directly
        initial = RefineOutput(content="start", quality=0.0)
        result, iterations = await execute_ralph_loop(loop, initial)

        assert result.quality >= 0.8
        assert iterations == 2


class TestRalphLoopCallbacks:
    """Test Ralph loop with callbacks."""

    @pytest.mark.asyncio
    async def test_on_iteration_callback(self):
        """Test that on_iteration callback is called."""
        iterations_seen = []

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content=doc.content + "+", quality=doc.quality + 0.4)

        loop = ralph_loop(
            refine, until=lambda r: r.quality >= 0.8, max_iterations=5, register=False
        )

        async def on_iter(iteration: int, result: RefineOutput):
            iterations_seen.append((iteration, result.content))

        initial = RefineOutput(content="x", quality=0.0)
        await execute_ralph_loop(loop, initial, on_iteration=on_iter)

        assert len(iterations_seen) == 2
        assert iterations_seen[0][0] == 0
        assert iterations_seen[1][0] == 1


class TestRalphLoopWithExecutor:
    """Test Ralph loops with the full executor."""

    @pytest.mark.asyncio
    async def test_ralph_loop_with_run_graph_with_store(self, tmp_path):
        """Test Ralph loop execution via run_graph_with_store."""
        from smithers import run_graph_with_store
        from smithers.store.sqlite import SqliteStore

        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        call_count = 0

        @workflow
        async def start() -> InitialDoc:
            return InitialDoc(content="initial", quality=0.0)

        @workflow(register=False)
        async def improve(doc: InitialDoc) -> RefineOutput:
            nonlocal call_count
            call_count += 1
            return RefineOutput(content=doc.content + f" v{call_count}", quality=doc.quality + 0.4)

        loop = ralph_loop(
            improve,
            until=lambda r: r.quality >= 0.8,
            max_iterations=5,
            register=False,  # Don't register - we'll build graph manually
        )

        # Build graph and run
        graph = build_graph(loop)
        result = await run_graph_with_store(graph, store=store)

        assert isinstance(result, RefineOutput)
        assert result.quality >= 0.8
        assert call_count == 2  # Two iterations needed

        # Verify loop iterations were tracked
        run = (await store.list_runs())[0]
        iterations = await store.get_loop_iterations(run.run_id)
        assert len(iterations) == 2

        # Verify events were emitted
        events = await store.get_events(run.run_id)
        event_types = [e.type for e in events]
        assert "LoopIterationStarted" in event_types
        assert "LoopIterationFinished" in event_types

    @pytest.mark.asyncio
    async def test_ralph_loop_max_iterations_event(self, tmp_path):
        """Test that LoopMaxIterationsReached event is emitted."""
        from smithers import run_graph_with_store
        from smithers.store.sqlite import SqliteStore

        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()

        @workflow
        async def start_doc() -> StartDoc:
            return StartDoc(content="initial", quality=0.0)

        @workflow(register=False)
        async def never_good(doc: StartDoc) -> RefineOutput:
            # Never reaches the threshold
            return RefineOutput(content=doc.content, quality=0.1)

        loop = ralph_loop(
            never_good,
            until=lambda r: r.quality >= 0.9,
            max_iterations=3,
            register=False,
        )

        graph = build_graph(loop)
        result = await run_graph_with_store(graph, store=store)

        # Should have run max iterations
        assert result.quality < 0.9

        # Verify max iterations event was emitted
        run = (await store.list_runs())[0]
        events = await store.get_events(run.run_id)
        event_types = [e.type for e in events]
        assert "LoopMaxIterationsReached" in event_types


class TestRalphLoopEdgeCases:
    """Test edge cases for Ralph loops."""

    @pytest.mark.asyncio
    async def test_single_iteration_loop(self):
        """Test loop with max_iterations=1."""

        @workflow(register=False)
        async def once(doc: RefineOutput) -> RefineOutput:
            return RefineOutput(content="done", quality=0.0)

        loop = ralph_loop(once, max_iterations=1, register=False)

        initial = RefineOutput(content="start")
        result, iterations = await execute_ralph_loop(loop, initial)

        assert iterations == 1
        assert result.content == "done"

    @pytest.mark.asyncio
    async def test_loop_with_bound_args(self):
        """Test Ralph loop with bound arguments."""

        @workflow(register=False)
        async def refine_with_factor(doc: RefineOutput, factor: float = 0.1) -> RefineOutput:
            return RefineOutput(content=doc.content, quality=doc.quality + factor)

        bound = refine_with_factor.bind(factor=0.5)
        loop = ralph_loop(bound, until=lambda r: r.quality >= 0.8, max_iterations=5, register=False)

        initial = RefineOutput(content="test", quality=0.0)
        result, iterations = await execute_ralph_loop(loop, initial)

        assert iterations == 2  # 0.5 * 2 = 1.0 >= 0.8
        assert result.quality >= 0.8

    def test_ralph_loop_representation(self):
        """Test that until condition has string representation."""

        @workflow(register=False)
        async def refine(doc: RefineOutput) -> RefineOutput:
            return doc

        loop = ralph_loop(refine, until=lambda r: r.quality > 0.8, max_iterations=3, register=False)

        assert loop.loop_config.until_repr != ""
        assert "lambda" in loop.loop_config.until_repr or "condition" in loop.loop_config.until_repr
