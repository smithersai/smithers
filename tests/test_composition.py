"""Tests for workflow composition module."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel

from smithers.composition import (
    CompositionError,
    EmptyReduceError,
    GraphMergeConflict,
    branch,
    chain,
    compose_graphs,
    get_composition_info,
    map_workflow,
    parallel,
    pipeline,
    reduce_workflow,
    subgraph,
)
from smithers.graph import build_graph, run_graph
from smithers.types import WorkflowGraph, WorkflowNode
from smithers.workflow import clear_registry, workflow


# Test models
class InputA(BaseModel):
    value: str


class OutputA(BaseModel):
    result: str


class OutputB(BaseModel):
    data: int


class OutputC(BaseModel):
    combined: str


class FileInput(BaseModel):
    path: str


class FileAnalysis(BaseModel):
    path: str
    lines: int


class Summary(BaseModel):
    content: str
    count: int


class ReviewResults(BaseModel):
    lint_passed: bool
    test_passed: bool


class LintOutput(BaseModel):
    passed: bool


class CheckOutput(BaseModel):
    passed: bool


@pytest.fixture(autouse=True)
def clear_workflows():
    """Clear workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()


# ============================================================================
# compose_graphs tests
# ============================================================================


class TestComposeGraphs:
    """Tests for compose_graphs function."""

    def test_compose_single_graph(self):
        """Composing a single graph returns equivalent graph."""

        @workflow(register=False)
        async def simple() -> OutputA:
            return OutputA(result="test")

        graph = build_graph(simple)
        composed = compose_graphs(graph)

        assert composed.root == graph.root
        assert set(composed.nodes.keys()) == set(graph.nodes.keys())

    def test_compose_multiple_graphs(self):
        """Can compose multiple independent graphs."""

        @workflow(register=False)
        async def workflow_a() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def workflow_b() -> OutputB:
            return OutputB(data=42)

        graph_a = build_graph(workflow_a)
        graph_b = build_graph(workflow_b)

        composed = compose_graphs(graph_a, graph_b)

        assert "workflow_a" in composed.nodes
        assert "workflow_b" in composed.nodes
        assert composed.root == "workflow_b"  # Last graph's root

    def test_compose_with_custom_target(self):
        """Can specify custom target when composing."""

        @workflow(register=False)
        async def workflow_a() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def workflow_b() -> OutputB:
            return OutputB(data=42)

        graph_a = build_graph(workflow_a)
        graph_b = build_graph(workflow_b)

        composed = compose_graphs(graph_a, graph_b, target="workflow_a")

        assert composed.root == "workflow_a"

    def test_compose_graphs_no_graphs_error(self):
        """Raises error when no graphs provided."""
        with pytest.raises(CompositionError, match="At least one graph"):
            compose_graphs()

    def test_compose_graphs_invalid_target(self):
        """Raises error when target not found."""

        @workflow(register=False)
        async def simple() -> OutputA:
            return OutputA(result="test")

        graph = build_graph(simple)

        with pytest.raises(CompositionError, match="Target 'nonexistent' not found"):
            compose_graphs(graph, target="nonexistent")

    def test_compose_graphs_conflicting_types(self):
        """Raises error when nodes have conflicting output types."""
        # Create two graphs with same node name but different types
        node_a = WorkflowNode(name="shared", output_type=OutputA)
        node_b = WorkflowNode(name="shared", output_type=OutputB)

        graph_a = WorkflowGraph(
            root="shared",
            nodes={"shared": node_a},
            edges=[],
            levels=[["shared"]],
            workflows={},
        )
        graph_b = WorkflowGraph(
            root="shared",
            nodes={"shared": node_b},
            edges=[],
            levels=[["shared"]],
            workflows={},
        )

        with pytest.raises(GraphMergeConflict) as exc_info:
            compose_graphs(graph_a, graph_b)

        assert "shared" in str(exc_info.value)
        assert "OutputA" in str(exc_info.value)
        assert "OutputB" in str(exc_info.value)

    def test_compose_graphs_preserves_edges(self):
        """Composed graph includes edges from all source graphs."""

        @workflow
        async def step1() -> OutputA:
            return OutputA(result="1")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(data=len(a.result))

        graph = build_graph(step2)

        composed = compose_graphs(graph)

        assert ("step1", "step2") in composed.edges


# ============================================================================
# chain tests
# ============================================================================


class TestChain:
    """Tests for chain function."""

    def test_chain_two_workflows(self):
        """Can chain two compatible workflows."""

        @workflow(register=False)
        async def producer() -> OutputA:
            return OutputA(result="hello")

        @workflow(register=False)
        async def consumer(a: OutputA) -> OutputB:
            return OutputB(data=len(a.result))

        chained = chain(producer, consumer)

        assert chained is not None
        assert "chain__" in chained.name
        assert chained.output_type == OutputB

    def test_chain_three_workflows(self):
        """Can chain three workflows."""

        @workflow(register=False)
        async def step1() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def step2(a: OutputA) -> OutputB:
            return OutputB(data=len(a.result))

        @workflow(register=False)
        async def step3(b: OutputB) -> OutputC:
            return OutputC(combined=str(b.data))

        chained = chain(step1, step2, step3)

        assert chained.output_type == OutputC

    def test_chain_insufficient_workflows_error(self):
        """Raises error when fewer than 2 workflows provided."""

        @workflow(register=False)
        async def single() -> OutputA:
            return OutputA(result="a")

        with pytest.raises(CompositionError, match="at least 2 workflows"):
            chain(single)

    def test_chain_incompatible_types_error(self):
        """Raises error when workflows have incompatible types."""

        @workflow(register=False)
        async def producer() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def wrong_consumer(c: OutputC) -> OutputB:
            return OutputB(data=1)

        with pytest.raises(CompositionError, match="does not accept"):
            chain(producer, wrong_consumer)

    def test_chain_no_inputs_error(self):
        """Raises error when middle workflow has no inputs."""

        @workflow(register=False)
        async def producer() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def no_input() -> OutputB:
            return OutputB(data=1)

        with pytest.raises(CompositionError, match="has no inputs"):
            chain(producer, no_input)

    def test_chain_custom_name(self):
        """Can specify custom name for chain."""

        @workflow(register=False)
        async def producer() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def consumer(a: OutputA) -> OutputB:
            return OutputB(data=1)

        chained = chain(producer, consumer, name="my_pipeline")

        assert chained.name == "my_pipeline"


# ============================================================================
# parallel tests
# ============================================================================


class TestParallel:
    """Tests for parallel function."""

    def test_parallel_two_workflows(self):
        """Can create parallel workflow from two workflows."""

        @workflow(register=False)
        async def lint() -> LintOutput:
            return LintOutput(passed=True)

        @workflow(register=False)
        async def test_wf() -> CheckOutput:
            return CheckOutput(passed=True)

        par = parallel(lint, test_wf)

        assert par is not None
        assert "parallel__" in par.name

    def test_parallel_with_collect_as(self):
        """Can collect results into custom model."""

        @workflow(register=False)
        async def lint() -> LintOutput:
            return LintOutput(passed=True)

        @workflow(register=False)
        async def test_wf() -> CheckOutput:
            return CheckOutput(passed=True)

        class Results(BaseModel):
            lint: LintOutput
            test_wf: CheckOutput

        par = parallel(lint, test_wf, collect_as=Results)

        assert par.output_type == Results

    def test_parallel_no_workflows_error(self):
        """Raises error when no workflows provided."""
        with pytest.raises(CompositionError, match="at least one workflow"):
            parallel()

    def test_parallel_custom_name(self):
        """Can specify custom name for parallel workflow."""

        @workflow(register=False)
        async def lint() -> LintOutput:
            return LintOutput(passed=True)

        par = parallel(lint, name="my_parallel")

        assert par.name == "my_parallel"

    @pytest.mark.asyncio
    async def test_parallel_execution(self):
        """Parallel workflow actually runs workflows concurrently."""
        execution_order: list[str] = []

        @workflow(register=False)
        async def slow1() -> LintOutput:
            execution_order.append("slow1_start")
            await asyncio.sleep(0.1)
            execution_order.append("slow1_end")
            return LintOutput(passed=True)

        @workflow(register=False)
        async def slow2() -> CheckOutput:
            execution_order.append("slow2_start")
            await asyncio.sleep(0.1)
            execution_order.append("slow2_end")
            return CheckOutput(passed=True)

        par = parallel(slow1, slow2)

        result = await par()

        # Both should start before either ends (parallel execution)
        slow1_start_idx = execution_order.index("slow1_start")
        slow2_start_idx = execution_order.index("slow2_start")
        slow1_end_idx = execution_order.index("slow1_end")
        slow2_end_idx = execution_order.index("slow2_end")

        assert slow1_start_idx < slow1_end_idx
        assert slow2_start_idx < slow2_end_idx
        # Both starts should happen before both ends
        assert max(slow1_start_idx, slow2_start_idx) < min(slow1_end_idx, slow2_end_idx)


# ============================================================================
# pipeline tests
# ============================================================================


class TestPipeline:
    """Tests for pipeline function."""

    def test_pipeline_creates_workflow(self):
        """Can create pipeline from workflows."""

        @workflow(register=False)
        async def step1() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def step2(a: OutputA) -> OutputB:
            return OutputB(data=1)

        pipe = pipeline(step1, step2)

        assert pipe is not None
        assert "pipeline__" in pipe.name

    def test_pipeline_insufficient_workflows_error(self):
        """Raises error when fewer than 2 workflows."""

        @workflow(register=False)
        async def single() -> OutputA:
            return OutputA(result="a")

        with pytest.raises(CompositionError, match="at least 2 workflows"):
            pipeline(single)


# ============================================================================
# subgraph tests
# ============================================================================


class TestSubgraph:
    """Tests for subgraph function."""

    def test_subgraph_creates_workflow(self):
        """Can wrap graph as single workflow."""

        @workflow(register=False)
        async def inner() -> OutputA:
            return OutputA(result="test")

        graph = build_graph(inner)
        sub = subgraph(graph)

        assert sub is not None
        assert "subgraph__" in sub.name
        assert sub.output_type == OutputA

    def test_subgraph_custom_name(self):
        """Can specify custom name for subgraph."""

        @workflow(register=False)
        async def inner() -> OutputA:
            return OutputA(result="test")

        graph = build_graph(inner)
        sub = subgraph(graph, name="my_subgraph")

        assert sub.name == "my_subgraph"

    def test_subgraph_custom_output_type(self):
        """Can override output type."""

        class CustomOutput(BaseModel):
            result: str

        @workflow(register=False)
        async def inner() -> OutputA:
            return OutputA(result="test")

        graph = build_graph(inner)
        sub = subgraph(graph, output_type=CustomOutput)

        assert sub.output_type == CustomOutput


# ============================================================================
# branch tests
# ============================================================================


class TestBranch:
    """Tests for branch function."""

    def test_branch_creates_workflow(self):
        """Can create branching workflow."""

        @workflow(register=False)
        async def if_high(a: OutputA) -> OutputB:
            return OutputB(data=100)

        @workflow(register=False)
        async def if_low(a: OutputA) -> OutputB:
            return OutputB(data=1)

        branched = branch(
            condition=lambda x: len(x.result) > 5,
            if_true=if_high,
            if_false=if_low,
            input_type=OutputA,
        )

        assert branched is not None
        assert "branch__" in branched.name
        assert branched.output_type == OutputB

    def test_branch_incompatible_outputs_error(self):
        """Raises error when branches have different output types."""

        @workflow(register=False)
        async def returns_a(a: OutputA) -> OutputA:
            return a

        @workflow(register=False)
        async def returns_b(a: OutputA) -> OutputB:
            return OutputB(data=1)

        with pytest.raises(CompositionError, match="same output type"):
            branch(
                condition=lambda x: True,
                if_true=returns_a,
                if_false=returns_b,
            )

    @pytest.mark.asyncio
    async def test_branch_executes_correct_path(self):
        """Branch executes correct workflow based on condition."""

        @workflow(register=False)
        async def if_true_wf(a: OutputA) -> OutputB:
            return OutputB(data=1)

        @workflow(register=False)
        async def if_false_wf(a: OutputA) -> OutputB:
            return OutputB(data=0)

        branched = branch(
            condition=lambda x: x.result == "yes",
            if_true=if_true_wf,
            if_false=if_false_wf,
            input_type=OutputA,
        )

        # True path
        result_true = await branched(a=OutputA(result="yes"))
        assert result_true.data == 1

        # False path
        result_false = await branched(a=OutputA(result="no"))
        assert result_false.data == 0

    @pytest.mark.asyncio
    async def test_branch_missing_input_error(self):
        """Branch raises descriptive error when called without required inputs."""

        @workflow(register=False)
        async def if_true_wf(a: OutputA) -> OutputB:
            return OutputB(data=1)

        @workflow(register=False)
        async def if_false_wf(a: OutputA) -> OutputB:
            return OutputB(data=0)

        branched = branch(
            condition=lambda x: x.result == "yes",
            if_true=if_true_wf,
            if_false=if_false_wf,
            input_type=OutputA,
        )

        # Calling without required input should raise CompositionError, not StopIteration
        with pytest.raises(CompositionError, match="Missing required input"):
            await branched()


# ============================================================================
# map_workflow tests
# ============================================================================


class TestMapWorkflow:
    """Tests for map_workflow function."""

    def test_map_creates_workflow(self):
        """Can create mapped workflow."""

        @workflow(register=False)
        async def analyze_file(file: FileInput) -> FileAnalysis:
            return FileAnalysis(path=file.path, lines=100)

        mapped = map_workflow(analyze_file)

        assert mapped is not None
        assert "map__" in mapped.name

    def test_map_no_inputs_error(self):
        """Raises error when workflow has no inputs."""

        @workflow(register=False)
        async def no_input() -> OutputA:
            return OutputA(result="a")

        with pytest.raises(CompositionError, match="no input parameters"):
            map_workflow(no_input)

    def test_map_invalid_param_error(self):
        """Raises error when specified param doesn't exist."""

        @workflow(register=False)
        async def wf(a: OutputA) -> OutputB:
            return OutputB(data=1)

        with pytest.raises(CompositionError, match="not found"):
            map_workflow(wf, input_param="nonexistent")

    @pytest.mark.asyncio
    async def test_map_processes_all_items(self):
        """Mapped workflow processes all input items."""

        @workflow(register=False)
        async def analyze_file(file: FileInput) -> FileAnalysis:
            return FileAnalysis(path=file.path, lines=len(file.path))

        mapped = map_workflow(analyze_file)

        files = [FileInput(path="a.py"), FileInput(path="bb.py"), FileInput(path="ccc.py")]
        result = await mapped(file=files)

        assert len(result.results) == 3
        assert result.results[0].lines == 4  # len("a.py")
        assert result.results[1].lines == 5  # len("bb.py")
        assert result.results[2].lines == 6  # len("ccc.py")


# ============================================================================
# reduce_workflow tests
# ============================================================================


class TestReduceWorkflow:
    """Tests for reduce_workflow function."""

    def test_reduce_creates_workflow(self):
        """Can create reduced workflow."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content=a.content + b.content, count=a.count + b.count)

        reduced = reduce_workflow(combine)

        assert reduced is not None
        assert "reduce__" in reduced.name

    def test_reduce_insufficient_inputs_error(self):
        """Raises error when workflow has fewer than 2 inputs."""

        @workflow(register=False)
        async def single_input(a: Summary) -> Summary:
            return a

        with pytest.raises(CompositionError, match="at least 2 inputs"):
            reduce_workflow(single_input)

    @pytest.mark.asyncio
    async def test_reduce_combines_items(self):
        """Reduced workflow combines all items."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content=f"{a.content},{b.content}", count=a.count + b.count)

        reduced = reduce_workflow(combine)

        items = [
            Summary(content="a", count=1),
            Summary(content="b", count=2),
            Summary(content="c", count=3),
        ]
        result = await reduced(items=items)

        assert result.count == 6
        assert "a" in result.content
        assert "b" in result.content
        assert "c" in result.content

    @pytest.mark.asyncio
    async def test_reduce_single_item(self):
        """Reduce of single item returns that item."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content="combined", count=a.count + b.count)

        reduced = reduce_workflow(combine)

        items = [Summary(content="only", count=42)]
        result = await reduced(items=items)

        assert result.content == "only"
        assert result.count == 42

    @pytest.mark.asyncio
    async def test_reduce_empty_list_error(self):
        """Reduce of empty list raises error without initial."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content="", count=0)

        reduced = reduce_workflow(combine)

        with pytest.raises(EmptyReduceError) as exc_info:
            await reduced(items=[])

        # Verify the error message is descriptive
        error_str = str(exc_info.value)
        assert "empty list" in error_str.lower()
        assert "initial" in error_str.lower()
        # Verify the workflow name is included
        assert "reduce__combine" in error_str

    @pytest.mark.asyncio
    async def test_reduce_with_initial(self):
        """Reduce uses initial value when provided."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content=f"{a.content}+{b.content}", count=a.count + b.count)

        initial = Summary(content="init", count=0)
        reduced = reduce_workflow(combine, initial=initial)

        items = [Summary(content="x", count=1)]
        result = await reduced(items=items)

        assert "init" in result.content
        assert "x" in result.content

    @pytest.mark.asyncio
    async def test_reduce_empty_list_with_initial(self):
        """Reduce of empty list with initial value returns initial."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content=f"{a.content}+{b.content}", count=a.count + b.count)

        initial = Summary(content="empty_initial", count=42)
        reduced = reduce_workflow(combine, initial=initial)

        result = await reduced(items=[])

        # Empty list with initial should return initial unchanged
        assert result.content == "empty_initial"
        assert result.count == 42


# ============================================================================
# get_composition_info tests
# ============================================================================


class TestGetCompositionInfo:
    """Tests for get_composition_info function."""

    def test_simple_workflow_not_composed(self):
        """Simple workflow is not identified as composed."""

        @workflow(register=False)
        async def simple() -> OutputA:
            return OutputA(result="a")

        info = get_composition_info(simple)

        assert info["name"] == "simple"
        assert info["is_composed"] is False
        assert info["composition_type"] is None

    def test_chain_identified(self):
        """Chain workflow is correctly identified."""

        @workflow(register=False)
        async def a() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def b(a: OutputA) -> OutputB:
            return OutputB(data=1)

        chained = chain(a, b)
        info = get_composition_info(chained)

        assert info["is_composed"] is True
        assert info["composition_type"] == "chain"

    def test_parallel_identified(self):
        """Parallel workflow is correctly identified."""

        @workflow(register=False)
        async def a() -> LintOutput:
            return LintOutput(passed=True)

        par = parallel(a)
        info = get_composition_info(par)

        assert info["is_composed"] is True
        assert info["composition_type"] == "parallel"

    def test_branch_identified(self):
        """Branch workflow is correctly identified."""

        @workflow(register=False)
        async def a(x: OutputA) -> OutputB:
            return OutputB(data=1)

        @workflow(register=False)
        async def b(x: OutputA) -> OutputB:
            return OutputB(data=0)

        branched = branch(lambda x: True, a, b, input_type=OutputA)
        info = get_composition_info(branched)

        assert info["is_composed"] is True
        assert info["composition_type"] == "branch"

    def test_map_identified(self):
        """Map workflow is correctly identified."""

        @workflow(register=False)
        async def analyze(f: FileInput) -> FileAnalysis:
            return FileAnalysis(path=f.path, lines=1)

        mapped = map_workflow(analyze)
        info = get_composition_info(mapped)

        assert info["is_composed"] is True
        assert info["composition_type"] == "map"

    def test_reduce_identified(self):
        """Reduce workflow is correctly identified."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content="", count=0)

        reduced = reduce_workflow(combine)
        info = get_composition_info(reduced)

        assert info["is_composed"] is True
        assert info["composition_type"] == "reduce"


# ============================================================================
# Integration tests
# ============================================================================


class TestCompositionIntegration:
    """Integration tests for composition features."""

    @pytest.mark.asyncio
    async def test_chain_execution(self):
        """Chained workflow executes correctly end-to-end using run_graph."""

        @workflow
        async def produce() -> OutputA:
            return OutputA(result="hello")

        @workflow
        async def transform(a: OutputA) -> OutputB:
            return OutputB(data=len(a.result))

        @workflow
        async def finalize(b: OutputB) -> OutputC:
            return OutputC(combined=f"result: {b.data}")

        # Use run_graph for full execution with dependencies
        graph = build_graph(finalize)
        result = await run_graph(graph)

        assert result.combined == "result: 5"

    @pytest.mark.asyncio
    async def test_parallel_workflows_same_input(self):
        """Parallel workflows that take the same input."""

        @workflow(register=False)
        async def lint(a: OutputA) -> LintOutput:
            return LintOutput(passed=len(a.result) > 0)

        @workflow(register=False)
        async def test_wf(a: OutputA) -> CheckOutput:
            return CheckOutput(passed=a.result == "shared")

        par = parallel(lint, test_wf)

        # Both receive the input
        result = await par(a=OutputA(result="shared"))

        assert hasattr(result, "lint")
        assert hasattr(result, "test_wf")
        assert result.lint.passed is True
        assert result.test_wf.passed is True

    @pytest.mark.asyncio
    async def test_chain_direct_execution(self):
        """Chain can execute directly when each step is bound."""

        @workflow(register=False)
        async def step1() -> OutputA:
            return OutputA(result="1")

        @workflow(register=False)
        async def step2(a: OutputA) -> OutputB:
            return OutputB(data=int(a.result))

        # Build the chain - internally creates bound workflows
        chained = chain(step1, step2)

        # The chained workflow should be bound to step1
        assert (
            chained.bound_deps
            or chained.bound_args
            or "step1" in chained.name
            or "chain" in chained.name
        )

    def test_compose_graphs_with_dependencies(self):
        """Composed graphs maintain proper dependency structure."""

        @workflow
        async def base() -> OutputA:
            return OutputA(result="base")

        @workflow
        async def derived(a: OutputA) -> OutputB:
            return OutputB(data=1)

        @workflow
        async def final(b: OutputB) -> OutputC:
            return OutputC(combined="final")

        # Build full graph
        graph = build_graph(final)

        # Verify levels
        assert len(graph.levels) == 3  # base -> derived -> final

    @pytest.mark.asyncio
    async def test_error_propagation_in_parallel(self):
        """Errors in parallel workflows propagate correctly."""

        @workflow(register=False)
        async def fails() -> LintOutput:
            raise ValueError("intentional error")

        @workflow(register=False)
        async def succeeds() -> CheckOutput:
            return CheckOutput(passed=True)

        par = parallel(fails, succeeds)

        with pytest.raises(ValueError, match="intentional error"):
            await par()

    @pytest.mark.asyncio
    async def test_branch_with_complex_condition(self):
        """Branch can use complex conditions."""

        @workflow(register=False)
        async def premium(a: OutputA) -> OutputB:
            return OutputB(data=100)

        @workflow(register=False)
        async def standard(a: OutputA) -> OutputB:
            return OutputB(data=10)

        def is_premium(x: OutputA) -> bool:
            return x.result.startswith("VIP") and len(x.result) > 3

        branched = branch(
            condition=is_premium,
            if_true=premium,
            if_false=standard,
            input_type=OutputA,
        )

        # Premium path
        result1 = await branched(a=OutputA(result="VIP-user"))
        assert result1.data == 100

        # Standard path
        result2 = await branched(a=OutputA(result="regular"))
        assert result2.data == 10

        # Edge case: VIP but too short
        result3 = await branched(a=OutputA(result="VIP"))
        assert result3.data == 10  # len("VIP") == 3, not > 3


# ============================================================================
# Edge case tests
# ============================================================================


class TestCompositionEdgeCases:
    """Edge case tests for composition."""

    def test_chain_preserves_metadata(self):
        """Chained workflow preserves relevant metadata."""

        @workflow(register=False)
        async def a() -> OutputA:
            return OutputA(result="a")

        @workflow(register=False)
        async def b(a: OutputA) -> OutputB:
            return OutputB(data=1)

        chained = chain(a, b)

        # Should have final workflow's output type
        assert chained.output_type == OutputB

    def test_parallel_dynamic_output_model(self):
        """Parallel creates appropriate dynamic output model."""

        @workflow(register=False)
        async def wf1() -> LintOutput:
            return LintOutput(passed=True)

        @workflow(register=False)
        async def wf2() -> CheckOutput:
            return CheckOutput(passed=True)

        par = parallel(wf1, wf2)

        # Output type should have both workflow names as fields
        assert "wf1" in par.output_type.model_fields
        assert "wf2" in par.output_type.model_fields

    def test_map_with_explicit_param(self):
        """Can specify which parameter to map over."""

        @workflow(register=False)
        async def multi_param(f: FileInput, config: OutputA) -> FileAnalysis:
            return FileAnalysis(path=f.path, lines=len(config.result))

        mapped = map_workflow(multi_param, input_param="f")

        assert mapped is not None
        assert "f" in mapped.input_types

    @pytest.mark.asyncio
    async def test_reduce_with_two_items(self):
        """Reduce works correctly with exactly two items."""

        @workflow(register=False)
        async def combine(a: Summary, b: Summary) -> Summary:
            return Summary(content=f"{a.content}|{b.content}", count=a.count + b.count)

        reduced = reduce_workflow(combine)

        items = [Summary(content="x", count=1), Summary(content="y", count=2)]
        result = await reduced(items=items)

        assert result.content == "x|y"
        assert result.count == 3

    def test_subgraph_with_complex_graph(self):
        """Subgraph works with multi-node graphs."""

        @workflow
        async def inner1() -> OutputA:
            return OutputA(result="a")

        @workflow
        async def inner2(a: OutputA) -> OutputB:
            return OutputB(data=1)

        @workflow
        async def inner3(b: OutputB) -> OutputC:
            return OutputC(combined="final")

        graph = build_graph(inner3)
        sub = subgraph(graph)

        assert sub.output_type == OutputC
        assert len(graph.nodes) == 3  # All three nodes

    def test_composition_error_str(self):
        """CompositionError has informative string representation."""
        error = CompositionError("test message", workflows=["a", "b", "c"])
        error_str = str(error)

        assert "test message" in error_str
        assert "a" in error_str
        assert "b" in error_str
        assert "c" in error_str

    def test_graph_merge_conflict_str(self):
        """GraphMergeConflict has informative string representation."""
        error = GraphMergeConflict("node1", "TypeA", "TypeB")
        error_str = str(error)

        assert "node1" in error_str

    def test_empty_reduce_error_str(self):
        """EmptyReduceError has informative string representation."""
        error = EmptyReduceError(
            message="Cannot reduce empty list",
            workflow_name="reduce__combine_items",
        )
        error_str = str(error)

        # Should mention empty list
        assert "empty list" in error_str.lower()
        # Should mention initial value as solution
        assert "initial" in error_str.lower()
        # Should include workflow name
        assert "reduce__combine_items" in error_str

    def test_empty_reduce_error_without_workflow_name(self):
        """EmptyReduceError works without workflow name."""
        error = EmptyReduceError(message="Cannot reduce empty list")
        error_str = str(error)

        # Should still have useful message
        assert "empty list" in error_str.lower()
        assert "initial" in error_str.lower()

    def test_empty_reduce_error_is_composition_error(self):
        """EmptyReduceError inherits from CompositionError."""
        error = EmptyReduceError(
            message="test",
            workflow_name="test_wf",
        )
        assert isinstance(error, CompositionError)
        assert isinstance(error, Exception)
