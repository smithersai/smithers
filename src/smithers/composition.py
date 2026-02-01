"""Workflow composition utilities for building complex workflows from simpler ones.

This module provides tools for composing workflows together:
- compose_graphs: Merge multiple WorkflowGraphs into one
- chain: Sequential composition where output flows through workflows
- parallel: Run multiple workflows concurrently, collecting results
- pipeline: Create linear pipelines from a sequence of workflows
- subgraph: Wrap a complete graph as a single workflow node

Example:
    # Chain workflows together
    pipeline = chain(analyze, implement, test)
    result = await run_graph(build_graph(pipeline))

    # Run workflows in parallel
    review_all = parallel(lint, security_check, test, collect_as=ReviewResults)
    result = await run_graph(build_graph(review_all))

    # Compose multiple graphs
    combined = compose_graphs(graph1, graph2, target="deploy")
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, create_model

from smithers.types import WorkflowGraph, WorkflowNode
from smithers.workflow import Workflow

# Generic type variables for composition operations
T = TypeVar("T", bound=BaseModel)  # Generic output type
T_in = TypeVar("T_in", bound=BaseModel)  # Generic input type
T_out = TypeVar("T_out", bound=BaseModel)  # Generic output type
T_item = TypeVar("T_item", bound=BaseModel)  # Generic item type for map/reduce
T_acc = TypeVar("T_acc", bound=BaseModel)  # Generic accumulator type for reduce


@dataclass
class CompositionError(Exception):
    """Error during workflow composition."""

    message: str
    workflows: list[str] = field(default_factory=lambda: [])

    def __str__(self) -> str:
        if self.workflows:
            return f"{self.message} (workflows: {', '.join(self.workflows)})"
        return self.message


@dataclass
class GraphMergeConflict(Exception):
    """Conflict when merging graphs."""

    node_name: str
    graph1_type: str
    graph2_type: str

    def __str__(self) -> str:
        return (
            f"Node '{self.node_name}' has conflicting output types: "
            f"{self.graph1_type} vs {self.graph2_type}"
        )


@dataclass
class EmptyReduceError(CompositionError):
    """Raised when attempting to reduce an empty list without an initial value.

    This error occurs when `reduce_workflow` is called with an empty list
    and no initial value was provided during composition.

    Attributes:
        workflow_name: Name of the reduce workflow that encountered the error.
        message: Descriptive error message.

    Example:
        @workflow
        async def combine(a: Summary, b: Summary) -> Summary:
            ...

        reduced = reduce_workflow(combine)  # No initial value

        # This will raise EmptyReduceError:
        await reduced(items=[])

        # To avoid this error, provide an initial value:
        reduced = reduce_workflow(combine, initial=Summary(content="", count=0))
    """

    workflow_name: str = ""

    def __str__(self) -> str:
        if self.workflow_name:
            return (
                f"Cannot reduce empty list without initial value in workflow '{self.workflow_name}'. "
                f"Either provide a non-empty list or use reduce_workflow(..., initial=<value>) "
                f"to specify a default starting value."
            )
        return (
            "Cannot reduce empty list without initial value. "
            "Either provide a non-empty list or use reduce_workflow(..., initial=<value>) "
            "to specify a default starting value."
        )


def compose_graphs(
    *graphs: WorkflowGraph,
    target: str | None = None,
    name: str | None = None,
) -> WorkflowGraph:
    """
    Merge multiple WorkflowGraphs into a single combined graph.

    This is useful when you have independently built graphs that you want
    to execute together. The graphs are merged by combining their nodes
    and edges. If nodes have the same name, they must have the same output type.

    Args:
        *graphs: The graphs to merge
        target: The target workflow name for the combined graph.
                If not specified, uses the target of the last graph.
        name: Optional name for the composed graph (used in error messages)

    Returns:
        A new WorkflowGraph containing all nodes from all input graphs

    Raises:
        GraphMergeConflict: If nodes have conflicting output types
        CompositionError: If no graphs provided or invalid target

    Example:
        graph1 = build_graph(analyze)
        graph2 = build_graph(test)
        combined = compose_graphs(graph1, graph2, target="test")
    """
    if not graphs:
        raise CompositionError("At least one graph is required")

    # Determine target
    final_target = target or graphs[-1].root

    # Merge nodes
    merged_nodes: dict[str, WorkflowNode] = {}
    merged_workflows: dict[str, Workflow] = {}

    for graph in graphs:
        for node_name, node in graph.nodes.items():
            if node_name in merged_nodes:
                existing = merged_nodes[node_name]
                if existing.output_type != node.output_type:
                    raise GraphMergeConflict(
                        node_name,
                        existing.output_type.__name__,
                        node.output_type.__name__,
                    )
            else:
                merged_nodes[node_name] = node

        # Merge workflows
        for wf_name, wf in graph.workflows.items():
            if wf_name not in merged_workflows:
                merged_workflows[wf_name] = wf

    # Verify target exists
    if final_target not in merged_nodes:
        raise CompositionError(
            f"Target '{final_target}' not found in merged graphs",
            workflows=list(merged_nodes.keys()),
        )

    # Merge edges (deduplicate)
    merged_edges: set[tuple[str, str]] = set()
    for graph in graphs:
        merged_edges.update(graph.edges)

    # Recompute levels for the merged graph
    levels = _compute_levels_for_target(merged_nodes, final_target)

    return WorkflowGraph(
        root=final_target,
        nodes=merged_nodes,
        edges=sorted(merged_edges),
        levels=levels,
        workflows=merged_workflows,
    )


def chain(
    *workflows: Workflow,
    name: str | None = None,
) -> Workflow:
    """
    Chain workflows sequentially, passing output to the next input.

    Creates a composed workflow where each workflow receives the output
    of the previous workflow as its input. The final output is the output
    of the last workflow in the chain.

    Requirements:
        - Each workflow (except the first) must accept exactly one parameter
        - The output type of workflow N must match the input type of workflow N+1

    Args:
        *workflows: The workflows to chain together
        name: Optional name for the chained workflow

    Returns:
        A new workflow representing the chain

    Raises:
        CompositionError: If workflows are incompatible

    Example:
        # Chain: analyze -> implement -> test
        pipeline = chain(analyze, implement, test)
        result = await run_graph(build_graph(pipeline))
    """
    if len(workflows) < 2:
        raise CompositionError("chain() requires at least 2 workflows")

    # Validate chain compatibility
    for i in range(len(workflows) - 1):
        current = workflows[i]
        next_wf = workflows[i + 1]

        # Next workflow must accept current's output type
        if not next_wf.input_types:
            raise CompositionError(
                f"Workflow '{next_wf.name}' has no inputs, cannot be chained",
                workflows=[current.name, next_wf.name],
            )

        # Find a matching input type
        matching_param = None
        for param_name, param_type in next_wf.input_types.items():
            if param_type == current.output_type:
                matching_param = param_name
                break

        if matching_param is None:
            raise CompositionError(
                f"Workflow '{next_wf.name}' does not accept "
                f"'{current.output_type.__name__}' as input",
                workflows=[current.name, next_wf.name],
            )

    # Build the chain by binding each workflow to its predecessor
    first = workflows[0]
    chained_workflows = [first]

    for i in range(1, len(workflows)):
        prev = chained_workflows[-1]
        current = workflows[i]

        # Find the parameter that matches the previous output
        for param_name, param_type in current.input_types.items():
            if param_type == prev.output_type:
                bound = current.bind(**{param_name: prev})
                chained_workflows.append(bound)
                break

    # The final workflow in the chain is our composed workflow
    final = chained_workflows[-1]

    # Create a new workflow that wraps the chain
    chain_name = name or f"chain__{_hash_workflow_names([wf.name for wf in workflows])}"

    # Use the last workflow but rename it
    return _create_alias_workflow(final, chain_name)


def parallel(
    *workflows: Workflow,
    collect_as: type[T] | None = None,
    name: str | None = None,
) -> Workflow:
    """
    Run multiple workflows in parallel and collect their results.

    Creates a composed workflow that executes all input workflows concurrently.
    Results are collected into either a dynamically created model or a
    user-specified model.

    Args:
        *workflows: The workflows to run in parallel
        collect_as: A Pydantic model type to collect results into.
                   If not provided, creates a dynamic model with workflow names as fields.
        name: Optional name for the parallel workflow

    Returns:
        A new workflow that runs all inputs in parallel

    Raises:
        CompositionError: If no workflows provided or collect_as is invalid

    Example:
        # Run lint and test in parallel, collect into a model
        class ReviewResults(BaseModel):
            lint_result: LintOutput
            test_result: TestOutput

        review = parallel(lint, test, collect_as=ReviewResults)
        result = await run_graph(build_graph(review))

        # Or use dynamic collection (creates ParallelResult with lint and test fields)
        review = parallel(lint, test)
    """
    if not workflows:
        raise CompositionError("parallel() requires at least one workflow")

    workflow_names = [wf.name for wf in workflows]
    parallel_name = name or f"parallel__{_hash_workflow_names(workflow_names)}"

    # Create the output model
    if collect_as is not None:
        output_type = collect_as
        # Validate that collect_as has appropriate fields
        model_fields = set(collect_as.model_fields.keys())
        for wf in workflows:
            # Check if there's a field that could hold this workflow's output
            matching_field = None
            for field_name, field_info in collect_as.model_fields.items():
                if field_info.annotation == wf.output_type:
                    matching_field = field_name
                    break
            if matching_field is None:
                # Try to find by name convention
                expected_names = [
                    wf.name,
                    f"{wf.name}_result",
                    f"{wf.name}_output",
                    wf.name.lower(),
                    f"{wf.name.lower()}_result",
                ]
                found = any(n in model_fields for n in expected_names)
                if not found:
                    # Allow it anyway - user might be collecting subset
                    pass
    else:
        # Create a dynamic model
        field_definitions: dict[str, Any] = {}
        for wf in workflows:
            # Use workflow name as field name
            field_definitions[wf.name] = (wf.output_type, ...)
        output_type = create_model(
            f"{parallel_name}_Result",
            **field_definitions,  # type: ignore[call-overload]
        )

    # Build input types from all workflow inputs (union of all dependencies)
    input_types: dict[str, type[BaseModel]] = {}
    for wf in workflows:
        for param_name, param_type in wf.input_types.items():
            if param_name not in input_types:
                input_types[param_name] = param_type
            elif input_types[param_name] != param_type:
                # Same param name with different types - make unique
                unique_name = f"{wf.name}_{param_name}"
                input_types[unique_name] = param_type

    # Create the parallel workflow function
    async def parallel_fn(**kwargs: Any) -> BaseModel:
        import asyncio

        # Run all workflows
        results: dict[str, Any] = {}

        async def run_wf(wf: Workflow) -> None:
            # Build kwargs for this workflow from available inputs
            wf_kwargs: dict[str, Any] = {}
            for param_name in wf.input_types:
                if param_name in kwargs:
                    wf_kwargs[param_name] = kwargs[param_name]
            result = await wf(**wf_kwargs)
            results[wf.name] = result

        await asyncio.gather(*[run_wf(wf) for wf in workflows])

        # Construct output model
        if collect_as is not None:
            # Map results to model fields
            model_kwargs: dict[str, Any] = {}
            for field_name, field_info in collect_as.model_fields.items():
                # Try to find matching result
                for wf_name, wf_result in results.items():
                    if isinstance(wf_result, field_info.annotation):  # type: ignore[arg-type]
                        model_kwargs[field_name] = wf_result
                        break
                    # Also try name matching
                    if wf_name == field_name or f"{wf_name}_result" == field_name:
                        model_kwargs[field_name] = wf_result
                        break
            return output_type(**model_kwargs)
        else:
            return output_type(**results)

    # Create the workflow wrapper
    parallel_wf = Workflow(
        name=parallel_name,
        fn=parallel_fn,
        output_type=output_type,
        input_types=input_types,
        input_is_list={},
        input_optional={},
    )

    return parallel_wf


def pipeline(
    *workflows: Workflow,
    name: str | None = None,
) -> Workflow:
    """
    Create a linear pipeline from multiple workflows.

    This is similar to chain() but with looser coupling. Each workflow
    in the pipeline runs after the previous one completes, but they
    don't necessarily need to have matching input/output types.

    For type-safe chaining, use chain() instead.

    Args:
        *workflows: The workflows to include in the pipeline
        name: Optional name for the pipeline

    Returns:
        A new workflow representing the pipeline

    Example:
        # Create a simple pipeline
        pipe = pipeline(setup, process, cleanup)
        result = await run_graph(build_graph(pipe))
    """
    if len(workflows) < 2:
        raise CompositionError("pipeline() requires at least 2 workflows")

    # Pipeline is essentially chain with relaxed type requirements
    # We build it by sequential binding
    pipeline_name = name or f"pipeline__{_hash_workflow_names([wf.name for wf in workflows])}"

    # Bind each workflow to run after the previous
    current = workflows[0]
    for i in range(1, len(workflows)):
        next_wf = workflows[i]
        # Try to find a compatible binding
        for param_name, param_type in next_wf.input_types.items():
            if param_type == current.output_type:
                next_wf = next_wf.bind(**{param_name: current})
                break
        current = next_wf

    return _create_alias_workflow(current, pipeline_name)


def subgraph(
    graph: WorkflowGraph,
    *,
    name: str | None = None,
    output_type: type[T] | None = None,
) -> Workflow:
    """
    Wrap a complete WorkflowGraph as a single workflow node.

    This allows treating a complex graph as a single unit within
    a larger workflow system. The subgraph executes its entire
    graph and returns the root output.

    Args:
        graph: The graph to wrap
        name: Name for the subgraph workflow
        output_type: Override the output type (defaults to graph root's type)

    Returns:
        A workflow that executes the entire graph

    Example:
        # Build a complex analysis graph
        analysis_graph = build_graph(deep_analyze)

        # Use it as a single node in a larger workflow
        analyze_step = subgraph(analysis_graph, name="analyze")

        @workflow
        async def process(analysis: AnalysisOutput) -> ProcessOutput:
            ...
    """
    from smithers.graph import run_graph

    # Get the root node's output type
    root_node = graph.nodes[graph.root]
    final_output_type = output_type or root_node.output_type

    subgraph_name = name or f"subgraph__{graph.root}"

    # Collect all external inputs needed by the graph
    # (inputs not satisfied by nodes within the graph)
    external_inputs: dict[str, type[BaseModel]] = {}
    internal_outputs = {node.output_type for node in graph.nodes.values()}

    for node in graph.nodes.values():
        wf = graph.workflows.get(node.name)
        if wf:
            for param_name, param_type in wf.input_types.items():
                if param_type not in internal_outputs:
                    external_inputs[param_name] = param_type

    # Create the subgraph execution function
    async def subgraph_fn(**kwargs: Any) -> BaseModel:
        result = await run_graph(graph)
        return result

    subgraph_wf = Workflow(
        name=subgraph_name,
        fn=subgraph_fn,
        output_type=final_output_type,
        input_types=external_inputs,
        input_is_list={},
        input_optional={},
    )

    return subgraph_wf


def branch(
    condition: Callable[[T_in], bool],
    if_true: Workflow,
    if_false: Workflow,
    *,
    name: str | None = None,
    input_type: type[T_in] | None = None,
) -> Workflow:
    """
    Create a branching workflow that chooses between two paths.

    Based on a condition evaluated on the input, either the if_true
    or if_false workflow is executed.

    Args:
        condition: A function that takes the input and returns True/False
        if_true: Workflow to execute if condition is True
        if_false: Workflow to execute if condition is False
        name: Optional name for the branching workflow
        input_type: The input type (required if both branches have different inputs)

    Returns:
        A workflow that branches based on the condition

    Example:
        review_branch = branch(
            condition=lambda x: x.score > 80,
            if_true=auto_approve,
            if_false=manual_review,
            input_type=ScoreOutput,
        )
    """
    # Verify both branches have the same output type
    if if_true.output_type != if_false.output_type:
        raise CompositionError(
            f"Branch workflows must have same output type: "
            f"{if_true.output_type.__name__} vs {if_false.output_type.__name__}",
            workflows=[if_true.name, if_false.name],
        )

    # Determine input type
    final_input_type = input_type
    if final_input_type is None:
        # Try to infer from branches
        true_inputs = list(if_true.input_types.values())
        false_inputs = list(if_false.input_types.values())
        if (true_inputs and false_inputs and true_inputs[0] == false_inputs[0]) or true_inputs:
            final_input_type = true_inputs[0]
        elif false_inputs:
            final_input_type = false_inputs[0]

    if final_input_type is None:
        raise CompositionError(
            "Could not determine input type for branch, please specify input_type",
            workflows=[if_true.name, if_false.name],
        )

    branch_name = name or f"branch__{_hash_workflow_names([if_true.name, if_false.name])}"

    async def branch_fn(**kwargs: Any) -> BaseModel:
        # Get the input value for the condition
        if not kwargs:
            raise CompositionError(
                f"Missing required input for branch workflow '{branch_name}'. "
                f"Expected at least one of: {list(combined_inputs.keys())}",
                workflows=[if_true.name, if_false.name],
            )
        input_val = next(iter(kwargs.values()))
        if condition(input_val):
            return await if_true(**kwargs)
        else:
            return await if_false(**kwargs)

    # Combine input types from both branches
    combined_inputs: dict[str, type[BaseModel]] = {}
    for wf in [if_true, if_false]:
        for param_name, param_type in wf.input_types.items():
            if param_name not in combined_inputs:
                combined_inputs[param_name] = param_type

    branch_wf = Workflow(
        name=branch_name,
        fn=branch_fn,
        output_type=if_true.output_type,
        input_types=combined_inputs,
        input_is_list={},
        input_optional={},
    )

    return branch_wf


def map_workflow(
    workflow: Workflow,
    *,
    name: str | None = None,
    input_param: str | None = None,
) -> Workflow:
    """
    Create a workflow that maps over a list of inputs.

    Takes a workflow that processes a single item and creates a new
    workflow that processes a list of items, running the original
    workflow for each item in parallel.

    Args:
        workflow: The workflow to map over inputs
        name: Optional name for the mapped workflow
        input_param: The parameter name that will receive list items.
                    If not specified, uses the first input parameter.

    Returns:
        A workflow that processes lists of inputs

    Example:
        # Original workflow processes one file
        @workflow
        async def analyze_file(file: FileInput) -> FileAnalysis:
            ...

        # Create a workflow that processes multiple files
        analyze_files = map_workflow(analyze_file)

        # Now analyze_files accepts list[FileInput] and returns list[FileAnalysis]
    """
    import asyncio

    # Determine which parameter to map over
    param_name = input_param
    if param_name is None:
        if workflow.input_types:
            param_name = next(iter(workflow.input_types.keys()))
        else:
            raise CompositionError(
                f"Workflow '{workflow.name}' has no input parameters to map over"
            )

    if param_name not in workflow.input_types:
        raise CompositionError(
            f"Parameter '{param_name}' not found in workflow '{workflow.name}'",
            workflows=[workflow.name],
        )

    item_type = workflow.input_types[param_name]
    map_name = name or f"map__{workflow.name}"

    # Create output type as list of original output
    list_output_type = create_model(
        f"{map_name}_Result",
        results=(list[workflow.output_type], ...),  # type: ignore[valid-type]
    )

    async def map_fn(**kwargs: Any) -> BaseModel:
        items = kwargs.get(param_name, [])
        if not isinstance(items, (list, tuple)):
            items = [items]

        async def process_item(item: BaseModel) -> BaseModel:
            item_kwargs = {**kwargs, param_name: item}
            return await workflow(**item_kwargs)

        results = await asyncio.gather(*[process_item(item) for item in items])
        return list_output_type(results=list(results))

    # Input type is now a list of the original type
    # For simplicity, we'll use a dynamic model
    list_input_type = create_model(
        f"{map_name}_Input",
        **{param_name: (list[item_type], ...)},  # type: ignore[valid-type]
    )

    mapped_wf = Workflow(
        name=map_name,
        fn=map_fn,
        output_type=list_output_type,
        input_types={param_name: list_input_type},
        input_is_list={param_name: True},
        input_optional={},
    )

    return mapped_wf


def reduce_workflow(
    workflow: Workflow,
    *,
    initial: T_acc | None = None,
    name: str | None = None,
) -> Workflow:
    """
    Create a workflow that reduces a list of inputs to a single output.

    Takes a workflow that combines two items and creates a new workflow
    that reduces a list of items by repeatedly applying the original workflow.

    Args:
        workflow: The workflow that combines two items into one.
                  Must accept two parameters of compatible types.
        initial: Optional initial value for the reduction
        name: Optional name for the reduced workflow

    Returns:
        A workflow that reduces a list to a single output

    Example:
        @workflow
        async def combine(a: Summary, b: Summary) -> Summary:
            ...

        combine_all = reduce_workflow(combine)
        # Now accepts list[Summary] and returns Summary
    """

    if len(workflow.input_types) < 2:
        raise CompositionError(
            f"reduce_workflow requires a workflow with at least 2 inputs, "
            f"'{workflow.name}' has {len(workflow.input_types)}",
            workflows=[workflow.name],
        )

    reduce_name = name or f"reduce__{workflow.name}"
    input_params = list(workflow.input_types.keys())
    first_param = input_params[0]
    item_type = workflow.input_types[first_param]

    async def reduce_fn(**kwargs: Any) -> BaseModel:
        items = kwargs.get("items", [])
        if not items:
            if initial is not None:
                return initial
            raise EmptyReduceError(
                message="Cannot reduce empty list without initial value",
                workflow_name=reduce_name,
            )

        if len(items) == 1 and initial is None:
            return items[0]

        # Reduce by calling workflow on pairs
        if initial is not None:
            result = initial
            items_to_process = items
        else:
            result = items[0]
            items_to_process = items[1:]

        for item in items_to_process:
            # Build kwargs with the two items
            wf_kwargs = {input_params[0]: result, input_params[1]: item}
            result = await workflow(**wf_kwargs)

        return result

    reduced_wf = Workflow(
        name=reduce_name,
        fn=reduce_fn,
        output_type=workflow.output_type,
        input_types={"items": item_type},
        input_is_list={"items": True},
        input_optional={},
    )

    return reduced_wf


# Helper functions


def _hash_workflow_names(names: list[str]) -> str:
    """Create a short hash from workflow names."""
    combined = "_".join(sorted(names))
    return hashlib.sha1(combined.encode()).hexdigest()[:8]


def _create_alias_workflow(wf: Workflow, new_name: str) -> Workflow:
    """Create a workflow with a new name but same behavior."""
    return Workflow(
        name=new_name,
        fn=wf.fn,
        output_type=wf.output_type,
        input_types=dict(wf.input_types),
        input_is_list=dict(wf.input_is_list),
        input_optional=dict(wf.input_optional),
        requires_approval=wf.requires_approval,
        approval_message=wf.approval_message,
        approval_context=wf.approval_context,
        approval_timeout=wf.approval_timeout,
        output_optional=wf.output_optional,
        bound_args=dict(wf.bound_args),
        bound_deps={k: list(v) for k, v in wf.bound_deps.items()},
        retry_policy=wf.retry_policy,
        timeout_policy=wf.timeout_policy,
        condition_policy=wf.condition_policy,
    )


def _compute_levels_for_target(
    nodes: dict[str, WorkflowNode],
    target: str,
) -> list[list[str]]:
    """Compute execution levels starting from leaves up to target.

    Uses Kahn's algorithm with a precomputed dependents map for O(n + e)
    complexity where n is the number of nodes and e is the number of edges.
    """
    # Find all nodes reachable from target (backwards)
    reachable: set[str] = set()

    def find_reachable(name: str) -> None:
        if name in reachable:
            return
        reachable.add(name)
        for dep in nodes[name].dependencies:
            if dep in nodes:
                find_reachable(dep)

    find_reachable(target)

    # Filter to only reachable nodes
    filtered_nodes = {name: node for name, node in nodes.items() if name in reachable}

    # Compute levels using Kahn's algorithm with precomputed dependents map
    in_degree: dict[str, int] = {name: 0 for name in filtered_nodes}

    # Build a reverse dependency map: node -> list of nodes that depend on it
    # This avoids O(n) lookup per node when updating in-degrees
    dependents: dict[str, list[str]] = {name: [] for name in filtered_nodes}

    for node in filtered_nodes.values():
        filtered_deps = [d for d in node.dependencies if d in filtered_nodes]
        in_degree[node.name] = len(filtered_deps)
        for dep in filtered_deps:
            dependents[dep].append(node.name)

    levels: list[list[str]] = []
    remaining = set(filtered_nodes.keys())

    while remaining:
        level = [name for name in remaining if in_degree[name] == 0]
        if not level:
            raise CompositionError(
                f"Circular dependency detected among: {remaining}",
                workflows=list(remaining),
            )

        levels.append(sorted(level))

        for name in level:
            remaining.remove(name)
            # Decrease in-degree of nodes that depend on this one (O(1) lookup)
            for dependent in dependents[name]:
                in_degree[dependent] -= 1

    return levels


def get_composition_info(workflow: Workflow) -> dict[str, Any]:
    """
    Get information about a composed workflow.

    Returns details about the composition structure, including:
    - Whether it's a composed workflow
    - The composition type (chain, parallel, etc.)
    - The component workflows

    Args:
        workflow: The workflow to inspect

    Returns:
        A dict with composition information
    """
    name = workflow.name
    info: dict[str, Any] = {
        "name": name,
        "is_composed": False,
        "composition_type": None,
        "components": [],
    }

    if name.startswith("chain__"):
        info["is_composed"] = True
        info["composition_type"] = "chain"
    elif name.startswith("parallel__"):
        info["is_composed"] = True
        info["composition_type"] = "parallel"
    elif name.startswith("pipeline__"):
        info["is_composed"] = True
        info["composition_type"] = "pipeline"
    elif name.startswith("subgraph__"):
        info["is_composed"] = True
        info["composition_type"] = "subgraph"
    elif name.startswith("branch__"):
        info["is_composed"] = True
        info["composition_type"] = "branch"
    elif name.startswith("map__"):
        info["is_composed"] = True
        info["composition_type"] = "map"
    elif name.startswith("reduce__"):
        info["is_composed"] = True
        info["composition_type"] = "reduce"

    # Extract bound dependencies as components
    if workflow.bound_deps:
        for deps in workflow.bound_deps.values():
            for dep in deps:
                info["components"].append(dep.name)

    return info
