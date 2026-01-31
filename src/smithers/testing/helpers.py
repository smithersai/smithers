"""Test utilities and helpers for Smithers workflows.

This module provides convenience utilities for testing Smithers workflows,
including:
- Graph assertion helpers
- Workflow testing utilities
- Mock data generators
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from pydantic import BaseModel

from smithers.graph import build_graph
from smithers.types import WorkflowGraph
from smithers.workflow import Workflow

T = TypeVar("T", bound=BaseModel)


def assert_graph_is_dag(graph: WorkflowGraph) -> None:
    """
    Assert that a graph has no cycles (is a valid DAG).

    This performs a topological sort check on the graph.
    Raises AssertionError if the graph contains cycles.

    Example:
        graph = build_graph(my_workflow)
        assert_graph_is_dag(graph)
    """
    visited: set[str] = set()
    rec_stack: set[str] = set()

    def _visit(node_name: str) -> bool:
        visited.add(node_name)
        rec_stack.add(node_name)

        node = graph.nodes.get(node_name)
        if node:
            for dep in node.dependencies:
                if dep not in visited:
                    if _visit(dep):
                        return True
                elif dep in rec_stack:
                    return True

        rec_stack.remove(node_name)
        return False

    for node_name in graph.nodes:
        if node_name not in visited:
            if _visit(node_name):
                raise AssertionError(f"Graph contains a cycle involving node: {node_name}")


def assert_graph_has_nodes(graph: WorkflowGraph, *expected_nodes: str) -> None:
    """
    Assert that a graph contains the expected nodes.

    Example:
        graph = build_graph(deploy)
        assert_graph_has_nodes(graph, "analyze", "implement", "test", "deploy")
    """
    actual_nodes = set(graph.nodes.keys())
    expected_set = set(expected_nodes)
    missing = expected_set - actual_nodes
    if missing:
        raise AssertionError(
            f"Graph missing expected nodes: {missing}. Actual nodes: {actual_nodes}"
        )


def assert_graph_has_dependency(
    graph: WorkflowGraph,
    from_node: str,
    to_node: str,
) -> None:
    """
    Assert that a graph has a specific dependency edge.

    Example:
        graph = build_graph(deploy)
        assert_graph_has_dependency(graph, "implement", "deploy")
    """
    node = graph.nodes.get(to_node)
    if node is None:
        raise AssertionError(f"Node '{to_node}' not found in graph")
    if from_node not in node.dependencies:
        raise AssertionError(
            f"Expected '{to_node}' to depend on '{from_node}', "
            f"but its dependencies are: {node.dependencies}"
        )


def assert_graph_levels(graph: WorkflowGraph, *expected_levels: list[str]) -> None:
    """
    Assert that a graph has the expected level structure.

    Example:
        graph = build_graph(deploy)
        assert_graph_levels(
            graph,
            ["analyze"],           # Level 0
            ["implement"],         # Level 1
            ["lint", "test"],      # Level 2 (parallel)
            ["deploy"],            # Level 3
        )
    """
    actual_levels = [set(level) for level in graph.levels]
    expected_sets = [set(level) for level in expected_levels]

    if len(actual_levels) != len(expected_sets):
        raise AssertionError(
            f"Expected {len(expected_sets)} levels, got {len(actual_levels)}. "
            f"Actual levels: {graph.levels}"
        )

    for i, (actual, expected) in enumerate(zip(actual_levels, expected_sets)):
        if actual != expected:
            raise AssertionError(f"Level {i} mismatch: expected {expected}, got {actual}")


def assert_workflow_produces(workflow: Workflow, output_type: type[BaseModel]) -> None:
    """
    Assert that a workflow produces the expected output type.

    Example:
        assert_workflow_produces(analyze, AnalysisOutput)
    """
    if workflow.output_type != output_type:
        raise AssertionError(
            f"Workflow '{workflow.name}' produces {workflow.output_type.__name__}, "
            f"expected {output_type.__name__}"
        )


def assert_workflow_depends_on(workflow: Workflow, *dependency_types: type[BaseModel]) -> None:
    """
    Assert that a workflow depends on the expected types.

    Example:
        assert_workflow_depends_on(implement, AnalysisOutput)
    """
    actual_deps = set(workflow.input_types.values())
    expected_deps = set(dependency_types)
    missing = expected_deps - actual_deps
    if missing:
        raise AssertionError(
            f"Workflow '{workflow.name}' missing expected dependencies: {missing}. "
            f"Actual dependencies: {actual_deps}"
        )


def mock_output(output_type: type[T], **field_values: Any) -> T:
    """
    Create a mock instance of a Pydantic output model.

    Uses sensible defaults for fields not provided.

    Example:
        analysis = mock_output(AnalysisOutput, files=["a.py"])
        # summary will be auto-filled with a default
    """
    from pydantic_core import PydanticUndefined

    # Get the model's field definitions
    fields = output_type.model_fields
    values: dict[str, Any] = {}

    for field_name, field_info in fields.items():
        if field_name in field_values:
            values[field_name] = field_values[field_name]
        elif field_info.default is not PydanticUndefined:
            values[field_name] = field_info.default
        elif field_info.default_factory is not None:
            values[field_name] = field_info.default_factory()
        else:
            # Generate a default based on type annotation
            annotation = field_info.annotation
            values[field_name] = _generate_default(annotation, field_name)

    return output_type(**values)


def _generate_default(annotation: Any, field_name: str) -> Any:
    """Generate a default value for a type annotation."""
    # Handle common types
    if annotation is str:
        return f"mock_{field_name}"
    if annotation is int:
        return 0
    if annotation is float:
        return 0.0
    if annotation is bool:
        return False
    if annotation is list or (hasattr(annotation, "__origin__") and annotation.__origin__ is list):
        return []
    if annotation is dict or (hasattr(annotation, "__origin__") and annotation.__origin__ is dict):
        return {}

    # Handle Optional types
    origin = getattr(annotation, "__origin__", None)
    if origin is type(None):
        return None

    # Try to handle Union types (e.g., str | None)
    args = getattr(annotation, "__args__", None)
    if args and type(None) in args:
        # It's an Optional, return None
        return None

    # Default fallback
    return None


def workflow_call_count(workflow: Workflow) -> Callable[[], int]:
    """
    Create a counter for workflow invocations.

    Returns a callable that returns the current count.
    Useful for verifying caching behavior.

    Example:
        count = workflow_call_count(analyze)
        await run_graph(graph)
        assert count() == 1
        await run_graph(graph)  # With cache
        assert count() == 1  # Not called again
    """
    call_count = [0]
    original_fn = workflow.fn

    async def counting_fn(*args: Any, **kwargs: Any) -> Any:
        call_count[0] += 1
        return await original_fn(*args, **kwargs)

    workflow.fn = counting_fn  # type: ignore

    return lambda: call_count[0]


def create_test_graph(
    *workflows: Workflow,
    target: Workflow | None = None,
) -> WorkflowGraph:
    """
    Create a test graph from a list of workflows.

    If target is not specified, uses the last workflow.

    Example:
        graph = create_test_graph(analyze, implement, deploy)
        # Equivalent to: build_graph(deploy)
    """
    target_wf = target or workflows[-1]
    return build_graph(target_wf)


class WorkflowTestCase:
    """
    Base class for workflow test cases.

    Provides helper methods for common workflow testing patterns.

    Example:
        class TestMyWorkflow(WorkflowTestCase):
            async def test_basic(self):
                fake = self.create_fake_llm([{"message": "Hello"}])
                with self.use_fake(fake):
                    result = await my_workflow()
                    assert result.message == "Hello"
    """

    def create_fake_llm(
        self,
        responses: list[dict[str, Any] | BaseModel],
    ):
        """Create a FakeLLMProvider with the given responses."""
        from smithers.testing.fakes import FakeLLMProvider

        return FakeLLMProvider(responses=responses)

    def create_fake_llm_by_type(
        self,
        responses_by_type: dict[type[BaseModel], dict[str, Any] | BaseModel],
    ):
        """Create a FakeLLMProvider with type-based responses (for parallel execution)."""
        from smithers.testing.fakes import FakeLLMProvider

        return FakeLLMProvider(responses_by_type=responses_by_type)

    def use_fake(self, fake_provider):
        """Context manager to use a fake LLM provider."""
        from smithers.testing.fakes import use_fake_llm

        return use_fake_llm(fake_provider)

    def use_runtime(self, *, llm=None, tools=None):
        """Context manager to use fake providers."""
        from smithers.testing.fakes import use_runtime

        return use_runtime(llm=llm, tools=tools)
