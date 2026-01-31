"""Tests for the enhanced graph visualization module."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import build_graph, workflow
from smithers.types import WorkflowResult
from smithers.visualization import (
    Colors,
    GraphVisualization,
    NodeState,
    NodeStatus,
    ProgressVisualizer,
    _colorize,
    _get_status_icon,
    _supports_color,
    _supports_unicode,
    create_progress_callback,
    print_graph,
    visualize_graph,
)
from smithers.workflow import clear_registry


class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    value: str


class OutputC(BaseModel):
    value: str


class OutputD(BaseModel):
    value: str


class OutputRoot(BaseModel):
    value: str


# Models for deep graph test
class Out1(BaseModel):
    v: str


class Out2(BaseModel):
    v: str


class Out3(BaseModel):
    v: str


class Out4(BaseModel):
    v: str


class Out5(BaseModel):
    v: str


# Models for wide graph test
class SourceModel(BaseModel):
    v: str


class BranchA(BaseModel):
    v: str


class BranchB(BaseModel):
    v: str


class BranchC(BaseModel):
    v: str


class BranchD(BaseModel):
    v: str


class SinkModel(BaseModel):
    v: str


# Model for single node test
class SingleOutput(BaseModel):
    value: str


@pytest.fixture(autouse=True)
def clear_workflows():
    """Clear workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()


@pytest.fixture
def simple_graph():
    """Create a simple two-node graph."""

    @workflow
    async def step_a() -> OutputA:
        return OutputA(value="a")

    @workflow
    async def step_b(dep: OutputA) -> OutputB:
        return OutputB(value="b")

    return build_graph(step_b)


@pytest.fixture
def diamond_graph():
    """Create a diamond-shaped graph (fan-out, fan-in)."""

    @workflow
    async def source() -> OutputA:
        return OutputA(value="a")

    @workflow
    async def left(dep: OutputA) -> OutputB:
        return OutputB(value="b")

    @workflow
    async def right(dep: OutputA) -> OutputC:
        return OutputC(value="c")

    @workflow
    async def sink(b: OutputB, c: OutputC) -> OutputRoot:
        return OutputRoot(value="root")

    return build_graph(sink)


@pytest.fixture
def complex_graph():
    """Create a more complex graph with multiple levels."""

    @workflow
    async def a() -> OutputA:
        return OutputA(value="a")

    @workflow
    async def b(dep: OutputA) -> OutputB:
        return OutputB(value="b")

    @workflow
    async def c(dep: OutputA) -> OutputC:
        return OutputC(value="c")

    @workflow
    async def d(b: OutputB, c: OutputC) -> OutputD:
        return OutputD(value="d")

    @workflow
    async def root(d: OutputD) -> OutputRoot:
        return OutputRoot(value="root")

    return build_graph(root)


class TestNodeStatus:
    """Tests for NodeStatus enum."""

    def test_status_values(self):
        """Test all status values exist (UPPERCASE as defined in store.sqlite)."""
        assert NodeStatus.PENDING == "PENDING"
        assert NodeStatus.READY == "READY"
        assert NodeStatus.RUNNING == "RUNNING"
        assert NodeStatus.CACHED == "CACHED"
        assert NodeStatus.SUCCESS == "SUCCESS"
        assert NodeStatus.SKIPPED == "SKIPPED"
        assert NodeStatus.FAILED == "FAILED"
        assert NodeStatus.CANCELLED == "CANCELLED"
        assert NodeStatus.PAUSED == "PAUSED"


class TestNodeState:
    """Tests for NodeState dataclass."""

    def test_default_state(self):
        """Test default node state."""
        state = NodeState(name="test")
        assert state.name == "test"
        assert state.status == NodeStatus.PENDING
        assert state.duration_ms is None
        assert state.cached is False
        assert state.error is None
        assert state.skip_reason is None

    def test_full_state(self):
        """Test fully populated node state."""
        state = NodeState(
            name="test",
            status=NodeStatus.SUCCESS,
            duration_ms=150.0,
            cached=False,
            error=None,
            skip_reason=None,
        )
        assert state.name == "test"
        assert state.status == NodeStatus.SUCCESS
        assert state.duration_ms == 150.0

    def test_failed_state(self):
        """Test failed node state."""
        state = NodeState(
            name="test",
            status=NodeStatus.FAILED,
            error="Something went wrong",
        )
        assert state.status == NodeStatus.FAILED
        assert state.error == "Something went wrong"


class TestColorHelpers:
    """Tests for color helper functions."""

    def test_colorize_enabled(self):
        """Test colorize with colors enabled."""
        result = _colorize("text", Colors.GREEN, use_colors=True)
        assert Colors.GREEN in result
        assert Colors.RESET in result
        assert "text" in result

    def test_colorize_disabled(self):
        """Test colorize with colors disabled."""
        result = _colorize("text", Colors.GREEN, use_colors=False)
        assert result == "text"
        assert Colors.GREEN not in result

    def test_status_icon_unicode(self):
        """Test Unicode status icons."""
        icon = _get_status_icon(NodeStatus.SUCCESS, use_unicode=True)
        assert icon == "✓"

        icon = _get_status_icon(NodeStatus.FAILED, use_unicode=True)
        assert icon == "✗"

        icon = _get_status_icon(NodeStatus.CACHED, use_unicode=True)
        assert icon == "◆"

    def test_status_icon_ascii(self):
        """Test ASCII fallback icons."""
        icon = _get_status_icon(NodeStatus.SUCCESS, use_unicode=False)
        assert icon == "+"

        icon = _get_status_icon(NodeStatus.FAILED, use_unicode=False)
        assert icon == "x"

        icon = _get_status_icon(NodeStatus.CACHED, use_unicode=False)
        assert icon == "#"


class TestGraphVisualization:
    """Tests for GraphVisualization class."""

    def test_initialization(self, simple_graph):
        """Test visualization initialization."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        assert viz.graph == simple_graph
        assert len(viz.node_states) == 2
        assert "step_a" in viz.node_states
        assert "step_b" in viz.node_states

    def test_update_from_results(self, simple_graph):
        """Test updating status from execution results."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)

        results = [
            WorkflowResult(
                name="step_a", output=OutputA(value="a"), cached=False, duration_ms=100.0
            ),
            WorkflowResult(name="step_b", output=OutputB(value="b"), cached=True, duration_ms=0.0),
        ]
        viz.update_from_results(results)

        assert viz.node_states["step_a"].status == NodeStatus.SUCCESS
        assert viz.node_states["step_a"].duration_ms == 100.0
        assert viz.node_states["step_b"].status == NodeStatus.CACHED
        assert viz.node_states["step_b"].cached is True

    def test_update_status_directly(self, simple_graph):
        """Test updating individual node status."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)

        viz.update_status("step_a", NodeStatus.RUNNING)
        assert viz.node_states["step_a"].status == NodeStatus.RUNNING

        viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=150.0)
        assert viz.node_states["step_a"].status == NodeStatus.SUCCESS
        assert viz.node_states["step_a"].duration_ms == 150.0

    def test_update_status_new_node(self, simple_graph):
        """Test updating status for a node not in initial states."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)

        viz.update_status("new_node", NodeStatus.RUNNING, error="Test error")
        assert "new_node" in viz.node_states
        assert viz.node_states["new_node"].status == NodeStatus.RUNNING
        assert viz.node_states["new_node"].error == "Test error"


class TestAsciiVisualization:
    """Tests for ASCII art visualization."""

    def test_simple_graph_ascii(self, simple_graph):
        """Test ASCII output for simple graph."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.ascii(show_status=False, show_timing=False)

        assert "step_a" in output
        assert "step_b" in output
        assert "Workflow Graph" in output

    def test_diamond_graph_ascii(self, diamond_graph):
        """Test ASCII output for diamond graph."""
        viz = GraphVisualization(graph=diamond_graph, use_colors=False, use_unicode=False)
        output = viz.ascii(show_status=False, show_timing=False)

        assert "source" in output
        assert "left" in output
        assert "right" in output
        assert "sink" in output

    def test_ascii_with_status(self, simple_graph):
        """Test ASCII output with status indicators."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS)
        viz.update_status("step_b", NodeStatus.PENDING)

        output = viz.ascii(show_status=True, show_timing=False)

        # Should contain status indicators
        assert "[" in output
        assert "]" in output
        assert "Legend" in output

    def test_ascii_with_timing(self, simple_graph):
        """Test ASCII output with timing information."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=100.0)

        output = viz.ascii(show_status=False, show_timing=True)

        assert "100ms" in output

    def test_ascii_unicode_mode(self, simple_graph):
        """Test ASCII output with Unicode characters."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=True)
        viz.update_status("step_a", NodeStatus.SUCCESS)

        output = viz.ascii(show_status=True, show_timing=False)

        # Should contain Unicode icons
        assert "✓" in output or "○" in output


class TestTreeVisualization:
    """Tests for tree visualization."""

    def test_simple_graph_tree(self, simple_graph):
        """Test tree output for simple graph."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.tree(show_status=False, show_timing=False)

        assert "step_b" in output
        assert "step_a" in output
        # Tree should show step_a as dependency of step_b
        lines = output.split("\n")
        step_b_line = next((i for i, l in enumerate(lines) if "step_b" in l), -1)
        step_a_line = next((i for i, l in enumerate(lines) if "step_a" in l), -1)
        # step_a should appear after step_b in tree view (as dependency)
        assert step_a_line > step_b_line

    def test_tree_with_status(self, simple_graph):
        """Test tree output with status indicators."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.CACHED)
        viz.update_status("step_b", NodeStatus.SUCCESS)

        output = viz.tree(show_status=True, show_timing=False)

        assert "[" in output
        assert "]" in output

    def test_tree_unicode_connectors(self, diamond_graph):
        """Test tree with Unicode box drawing."""
        viz = GraphVisualization(graph=diamond_graph, use_colors=False, use_unicode=True)
        output = viz.tree(show_status=False, show_timing=False)

        # Should contain Unicode tree connectors
        assert "├" in output or "└" in output or "│" in output


class TestTableVisualization:
    """Tests for table visualization."""

    def test_simple_graph_table(self, simple_graph):
        """Test table output for simple graph."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.table()

        assert "Node" in output
        assert "Status" in output
        assert "Duration" in output
        assert "Cached" in output
        assert "step_a" in output
        assert "step_b" in output

    def test_table_with_data(self, simple_graph):
        """Test table with populated data."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=150.0)
        viz.node_states["step_a"].cached = False
        viz.update_status("step_b", NodeStatus.CACHED, duration_ms=0.0)
        viz.node_states["step_b"].cached = True

        output = viz.table()

        assert "150ms" in output
        assert "Yes" in output  # Cached
        assert "No" in output  # Not cached

    def test_table_unicode_borders(self, simple_graph):
        """Test table with Unicode borders."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=True)
        output = viz.table()

        # Should contain Unicode box drawing
        assert "┌" in output
        assert "└" in output
        assert "─" in output
        assert "│" in output


class TestMermaidStyled:
    """Tests for styled Mermaid output."""

    def test_mermaid_basic(self, simple_graph):
        """Test basic Mermaid output."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.mermaid_styled()

        assert "graph LR" in output
        assert "step_a" in output
        assert "step_b" in output
        assert "-->" in output

    def test_mermaid_with_classes(self, simple_graph):
        """Test Mermaid output with status classes."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS)
        viz.update_status("step_b", NodeStatus.PENDING)

        output = viz.mermaid_styled()

        assert "classDef success" in output
        assert "classDef pending" in output
        assert "class step_a success" in output
        assert "class step_b pending" in output

    def test_mermaid_with_timing(self, simple_graph):
        """Test Mermaid output with timing labels."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=100.0)

        output = viz.mermaid_styled()

        # Timing should be in node label
        assert "100ms" in output

    def test_mermaid_all_status_classes(self, simple_graph):
        """Test all status class definitions are present."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.mermaid_styled()

        assert "classDef pending" in output
        assert "classDef running" in output
        assert "classDef success" in output
        assert "classDef cached" in output
        assert "classDef skipped" in output
        assert "classDef failed" in output


class TestSummary:
    """Tests for summary output."""

    def test_simple_summary(self, simple_graph):
        """Test basic summary output."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        output = viz.summary()

        assert "Graph: step_b" in output
        assert "Total nodes: 2" in output

    def test_summary_with_status(self, simple_graph):
        """Test summary with status breakdown."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)
        viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=100.0)
        viz.update_status("step_b", NodeStatus.CACHED, duration_ms=0.0)

        output = viz.summary()

        assert "success" in output
        assert "cached" in output
        assert "100ms" in output  # Total duration


class TestVisualizeGraphFunction:
    """Tests for the visualize_graph convenience function."""

    def test_ascii_format(self, simple_graph):
        """Test ASCII format output."""
        output = visualize_graph(simple_graph, format="ascii", use_colors=False, use_unicode=False)
        assert "step_a" in output
        assert "step_b" in output

    def test_tree_format(self, simple_graph):
        """Test tree format output."""
        output = visualize_graph(simple_graph, format="tree", use_colors=False, use_unicode=False)
        assert "step_b" in output
        assert "step_a" in output

    def test_table_format(self, simple_graph):
        """Test table format output."""
        output = visualize_graph(simple_graph, format="table", use_colors=False, use_unicode=False)
        assert "Node" in output
        assert "Status" in output

    def test_mermaid_format(self, simple_graph):
        """Test mermaid format output."""
        output = visualize_graph(
            simple_graph, format="mermaid", use_colors=False, use_unicode=False
        )
        assert "graph LR" in output

    def test_summary_format(self, simple_graph):
        """Test summary format output."""
        output = visualize_graph(
            simple_graph, format="summary", use_colors=False, use_unicode=False
        )
        assert "Total nodes" in output

    def test_with_results(self, simple_graph):
        """Test visualization with execution results."""
        results = [
            WorkflowResult(
                name="step_a", output=OutputA(value="a"), cached=False, duration_ms=100.0
            ),
            WorkflowResult(name="step_b", output=OutputB(value="b"), cached=True, duration_ms=0.0),
        ]
        output = visualize_graph(
            simple_graph,
            format="table",
            use_colors=False,
            use_unicode=False,
            results=results,
        )

        assert "100ms" in output

    def test_with_node_statuses(self, simple_graph):
        """Test visualization with node status dict."""
        statuses = {
            "step_a": "success",
            "step_b": "running",
        }
        output = visualize_graph(
            simple_graph,
            format="table",
            use_colors=False,
            use_unicode=False,
            node_statuses=statuses,
        )

        assert "Success" in output or "success" in output
        assert "Running" in output or "running" in output

    def test_invalid_format(self, simple_graph):
        """Test error on invalid format."""
        with pytest.raises(ValueError, match="Unknown format"):
            visualize_graph(simple_graph, format="invalid")


class TestPrintGraph:
    """Tests for print_graph function."""

    def test_print_graph(self, simple_graph, capsys):
        """Test print_graph outputs to stdout."""
        print_graph(simple_graph, format="summary", use_colors=False, use_unicode=False)
        captured = capsys.readouterr()

        assert "Graph: step_b" in captured.out
        assert "Total nodes: 2" in captured.out


class TestColorDetection:
    """Tests for terminal capability detection."""

    def test_supports_color_function_exists(self):
        """Test that supports_color function exists and returns bool."""
        result = _supports_color()
        assert isinstance(result, bool)

    def test_supports_unicode_function_exists(self):
        """Test that supports_unicode function exists and returns bool."""
        result = _supports_unicode()
        assert isinstance(result, bool)


class TestComplexGraphs:
    """Tests with more complex graph structures."""

    def test_deep_graph(self):
        """Test visualization of a deep graph."""
        clear_registry()

        @workflow
        async def level1() -> Out1:
            return Out1(v="1")

        @workflow
        async def level2(dep: Out1) -> Out2:
            return Out2(v="2")

        @workflow
        async def level3(dep: Out2) -> Out3:
            return Out3(v="3")

        @workflow
        async def level4(dep: Out3) -> Out4:
            return Out4(v="4")

        @workflow
        async def level5(dep: Out4) -> Out5:
            return Out5(v="5")

        graph = build_graph(level5)

        # Test all formats work
        ascii_out = visualize_graph(graph, format="ascii", use_colors=False, use_unicode=False)
        assert "level1" in ascii_out
        assert "level5" in ascii_out

        tree_out = visualize_graph(graph, format="tree", use_colors=False, use_unicode=False)
        assert "level1" in tree_out
        assert "level5" in tree_out

        table_out = visualize_graph(graph, format="table", use_colors=False, use_unicode=False)
        assert "level1" in table_out
        assert "level5" in table_out

    def test_wide_graph(self):
        """Test visualization of a wide graph (many nodes at same level)."""
        clear_registry()

        @workflow
        async def source() -> SourceModel:
            return SourceModel(v="s")

        @workflow
        async def branch_a(dep: SourceModel) -> BranchA:
            return BranchA(v="a")

        @workflow
        async def branch_b(dep: SourceModel) -> BranchB:
            return BranchB(v="b")

        @workflow
        async def branch_c(dep: SourceModel) -> BranchC:
            return BranchC(v="c")

        @workflow
        async def branch_d(dep: SourceModel) -> BranchD:
            return BranchD(v="d")

        @workflow
        async def sink(a: BranchA, b: BranchB, c: BranchC, d: BranchD) -> SinkModel:
            return SinkModel(v="sink")

        graph = build_graph(sink)

        # Test all formats work
        ascii_out = visualize_graph(graph, format="ascii", use_colors=False, use_unicode=False)
        assert "source" in ascii_out
        assert "sink" in ascii_out
        assert "branch_a" in ascii_out
        assert "branch_d" in ascii_out

        table_out = visualize_graph(graph, format="table", use_colors=False, use_unicode=False)
        # Should have 6 nodes
        assert table_out.count("branch") == 4


class TestProgressVisualizer:
    """Tests for ProgressVisualizer class."""

    def test_initialization(self, simple_graph):
        """Test progress visualizer initialization."""
        viz = ProgressVisualizer(
            simple_graph,
            format="table",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )
        assert viz.format == "table"
        assert viz.clear_screen is False
        assert len(viz.viz.node_states) == 2

    @pytest.mark.asyncio
    async def test_update_started_event(self, simple_graph):
        """Test handling started event."""
        viz = ProgressVisualizer(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )

        # Simulate a started event
        class MockEvent:
            type = "started"
            workflow_name = "step_a"
            duration_ms = None
            message = None

        await viz.update(MockEvent())
        assert viz.viz.node_states["step_a"].status == NodeStatus.RUNNING

    @pytest.mark.asyncio
    async def test_update_completed_event(self, simple_graph):
        """Test handling completed event."""
        viz = ProgressVisualizer(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )

        class MockEvent:
            type = "completed"
            workflow_name = "step_a"
            duration_ms = 150.0
            message = None

        await viz.update(MockEvent())
        assert viz.viz.node_states["step_a"].status == NodeStatus.SUCCESS
        assert viz.viz.node_states["step_a"].duration_ms == 150.0

    @pytest.mark.asyncio
    async def test_update_cached_event(self, simple_graph):
        """Test handling cached event."""
        viz = ProgressVisualizer(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )

        class MockEvent:
            type = "cached"
            workflow_name = "step_b"
            duration_ms = None
            message = None

        await viz.update(MockEvent())
        assert viz.viz.node_states["step_b"].status == NodeStatus.CACHED
        assert viz.viz.node_states["step_b"].cached is True

    @pytest.mark.asyncio
    async def test_update_failed_event(self, simple_graph):
        """Test handling failed event."""
        viz = ProgressVisualizer(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )

        class MockEvent:
            type = "failed"
            workflow_name = "step_a"
            duration_ms = None
            message = "Something went wrong"

        await viz.update(MockEvent())
        assert viz.viz.node_states["step_a"].status == NodeStatus.FAILED
        assert viz.viz.node_states["step_a"].error == "Something went wrong"

    @pytest.mark.asyncio
    async def test_update_skipped_event(self, simple_graph):
        """Test handling skipped event."""
        viz = ProgressVisualizer(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )

        class MockEvent:
            type = "skipped"
            workflow_name = "step_b"
            duration_ms = None
            message = "Dependency failed"

        await viz.update(MockEvent())
        assert viz.viz.node_states["step_b"].status == NodeStatus.SKIPPED

    def test_final_report(self, simple_graph):
        """Test final report generation."""
        viz = ProgressVisualizer(
            simple_graph,
            format="table",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )
        viz.viz.update_status("step_a", NodeStatus.SUCCESS, duration_ms=100.0)
        viz.viz.update_status("step_b", NodeStatus.SUCCESS, duration_ms=200.0)

        report = viz.final_report()
        assert "step_a" in report
        assert "step_b" in report
        assert "Total nodes" in report


class TestCreateProgressCallback:
    """Tests for create_progress_callback function."""

    def test_create_callback(self, simple_graph):
        """Test creating a progress callback."""
        viz, callback = create_progress_callback(
            simple_graph,
            format="summary",
            use_colors=False,
            use_unicode=False,
            clear_screen=False,
        )
        assert isinstance(viz, ProgressVisualizer)
        assert callable(callback)
        assert callback == viz.update

    def test_callback_defaults(self, simple_graph):
        """Test default parameters for progress callback."""
        viz, callback = create_progress_callback(simple_graph)
        assert viz.format == "summary"
        assert viz.clear_screen is False


class TestEdgeCases:
    """Tests for edge cases."""

    def test_empty_graph_visualization(self):
        """Test that visualization handles empty graphs gracefully.

        An empty graph (no nodes) should not crash when visualizing with any format.
        This tests the fix for a ValueError: max() iterable argument is empty bug.
        """
        from smithers.types import WorkflowGraph

        # Create an empty graph with no nodes
        empty_graph = WorkflowGraph(
            root="empty",
            nodes={},
            edges=[],
            levels=[],
            workflows={},
        )

        # ASCII format should handle empty graph
        output = visualize_graph(empty_graph, format="ascii", use_colors=False, use_unicode=False)
        assert "empty graph" in output.lower() or "Workflow Graph" in output

        # Table format should handle empty graph without crashing
        output = visualize_graph(empty_graph, format="table", use_colors=False, use_unicode=False)
        assert "Node" in output  # Headers should still be present
        # Should not contain any node rows (just header)

        # Tree format should handle empty graph
        output = visualize_graph(empty_graph, format="tree", use_colors=False, use_unicode=False)
        assert "Workflow Graph" in output

        # Mermaid format should handle empty graph
        output = visualize_graph(empty_graph, format="mermaid", use_colors=False, use_unicode=False)
        assert "graph LR" in output

        # Summary format should handle empty graph
        output = visualize_graph(empty_graph, format="summary", use_colors=False, use_unicode=False)
        assert "Total nodes: 0" in output

    def test_single_node_graph(self):
        """Test visualization of a single-node graph."""
        clear_registry()

        @workflow
        async def single() -> SingleOutput:
            return SingleOutput(value="single")

        graph = build_graph(single)

        output = visualize_graph(graph, format="ascii", use_colors=False, use_unicode=False)
        assert "single" in output

        output = visualize_graph(graph, format="table", use_colors=False, use_unicode=False)
        assert "single" in output

    def test_empty_node_states(self, simple_graph):
        """Test visualization with no status updates."""
        viz = GraphVisualization(graph=simple_graph, use_colors=False, use_unicode=False)

        # All nodes should be pending by default
        for state in viz.node_states.values():
            assert state.status == NodeStatus.PENDING

        output = viz.ascii(show_status=True, show_timing=True)
        assert "step_a" in output
        assert "step_b" in output
