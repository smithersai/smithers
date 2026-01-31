"""Shared helper functions for graph execution.

This module contains helper functions that are used by both graph.py and executor.py
to avoid code duplication. These functions handle common operations like resolving
workflows, building kwargs, validating outputs, and computing hashes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, TypeAdapter

from smithers.errors import MissingProducerError
from smithers.hashing import code_hash, hash_json
from smithers.hashing import input_hash as compute_input_hash
from smithers.workflow import Workflow, get_all_workflows, get_workflow_by_output

# Cache TypeAdapters by output type to avoid repeated initialization overhead.
# TypeAdapter initialization is expensive as it parses and compiles type schemas.
# Output types are typically module-level classes that live for the program's lifetime,
# so a regular dict is appropriate (no need for weak references).
_TYPE_ADAPTER_CACHE: dict[type[BaseModel], TypeAdapter[BaseModel]] = {}

if TYPE_CHECKING:
    from smithers.types import WorkflowGraph, WorkflowNode


def normalize_invalidate(
    invalidate: Iterable[object] | str | Workflow | None,
) -> set[str]:
    """Normalize invalidate argument to a set of workflow names.

    Args:
        invalidate: Can be None, a single workflow name, a Workflow,
            or an iterable of workflow names/Workflow objects.

    Returns:
        A set of workflow names to invalidate.
    """
    if invalidate is None:
        return set()
    if isinstance(invalidate, Workflow):
        return {invalidate.name}
    if isinstance(invalidate, str):
        return {invalidate}
    normalized: set[str] = set()
    for item in invalidate:
        if isinstance(item, Workflow):
            normalized.add(item.name)
        elif isinstance(item, str):
            normalized.add(item)
        else:
            raise TypeError("invalidate must contain workflow names (str) or Workflow objects")
    return normalized


def resolve_workflow(graph: WorkflowGraph, node: WorkflowNode) -> Workflow:
    """Resolve a workflow from a graph node.

    Args:
        graph: The workflow graph containing workflow references.
        node: The node to resolve the workflow for.

    Returns:
        The resolved Workflow object.

    Raises:
        ValueError: If no workflow is registered for the node's output type.
    """
    if node.name in graph.workflows:
        return graph.workflows[node.name]
    wf = get_workflow_by_output(node.output_type)
    if wf is None:
        raise ValueError(f"No workflow registered for output type {node.output_type.__name__}")
    return wf


def build_kwargs(wf: Workflow, outputs: dict[str, Any]) -> dict[str, Any]:
    """Build keyword arguments for a workflow invocation.

    Resolves dependencies from the outputs dictionary to build the kwargs
    that will be passed to the workflow function.

    Args:
        wf: The workflow to build kwargs for.
        outputs: Dictionary of workflow name -> output value.

    Returns:
        Dictionary of parameter name -> value for the workflow call.

    Raises:
        ValueError: If a required dependency workflow is not found.
    """
    # Avoid allocating a new dict if bound_args is empty (common case)
    kwargs: dict[str, Any] = dict(wf.bound_args) if wf.bound_args else {}
    for param_name, param_type in wf.input_types.items():
        if param_name in wf.bound_args:
            continue
        if param_name in wf.bound_deps:
            deps = wf.bound_deps[param_name]
            if wf.input_is_list.get(param_name, False):
                kwargs[param_name] = [outputs[dep.name] for dep in deps]
            else:
                kwargs[param_name] = outputs[deps[0].name]
            continue

        dep_wf = get_workflow_by_output(param_type)
        if dep_wf is None:
            registered = [t.__name__ for t in get_all_workflows()]
            raise MissingProducerError(
                workflow_name=wf.name,
                param_name=param_name,
                required_type=param_type,
                registered_types=registered,
            )
        if wf.input_is_list.get(param_name, False):
            kwargs[param_name] = [outputs[dep_wf.name]]
        else:
            kwargs[param_name] = outputs[dep_wf.name]

    return kwargs


def _get_type_adapter(output_type: type[BaseModel]) -> TypeAdapter[BaseModel]:
    """Get or create a cached TypeAdapter for the given output type.

    TypeAdapter initialization is expensive as it involves parsing and compiling
    type schemas. This function caches adapters to avoid repeated overhead.

    Args:
        output_type: The Pydantic model type to create an adapter for.

    Returns:
        A TypeAdapter instance for the given type.
    """
    adapter = _TYPE_ADAPTER_CACHE.get(output_type)
    if adapter is None:
        adapter = TypeAdapter(output_type)
        _TYPE_ADAPTER_CACHE[output_type] = adapter
    return adapter


def validate_output(wf: Workflow, output: Any) -> Any:
    """Validate a workflow output against its declared type.

    Args:
        wf: The workflow whose output type to validate against.
        output: The output value to validate.

    Returns:
        The validated output (may be coerced to the correct type).
    """
    if output is None and wf.output_optional:
        return None
    adapter = _get_type_adapter(wf.output_type)
    return adapter.validate_python(output)


def hash_inputs(wf: Workflow, outputs: dict[str, Any]) -> str:
    """Compute a hash of the workflow's inputs.

    The hash includes bound arguments and dependency outputs,
    and is used for cache key computation.

    Args:
        wf: The workflow to hash inputs for.
        outputs: Dictionary of workflow name -> output value.

    Returns:
        A hash string representing the inputs.
    """
    inputs: dict[str, Any] = {}

    # Add bound arguments
    inputs["bound_args"] = wf.bound_args

    # Add dependency outputs
    deps: dict[str, Any] = {}
    for param_name, param_type in wf.input_types.items():
        if param_name in wf.bound_deps:
            bound_deps = wf.bound_deps[param_name]
            deps[param_name] = [outputs[dep.name] for dep in bound_deps]
            continue
        if param_name in wf.bound_args:
            continue
        dep_wf = get_workflow_by_output(param_type)
        if dep_wf is None:
            continue
        if wf.input_is_list.get(param_name, False):
            deps[param_name] = [outputs[dep_wf.name]]
        else:
            deps[param_name] = outputs[dep_wf.name]

    inputs["deps"] = deps
    return compute_input_hash(inputs)


def compute_cache_key(wf: Workflow, input_hash_value: str) -> str:
    """Compute a cache key for a workflow invocation.

    The cache key combines:
    - Workflow name
    - Code hash (changes when workflow code changes)
    - Input hash (changes when inputs change)

    This ensures cache invalidation when workflow code or inputs change.

    Args:
        wf: The workflow to compute a cache key for.
        input_hash_value: Pre-computed input hash.

    Returns:
        A hash string to use as the cache key.
    """
    return hash_json(
        {
            "workflow_name": wf.name,
            "code_hash": code_hash(wf),
            "input_hash": input_hash_value,
        }
    )


def dependency_namespace(wf: Workflow, outputs: dict[str, Any]) -> SimpleNamespace:
    """Build a namespace of dependency values for condition evaluation.

    Creates a SimpleNamespace where each attribute is a dependency value,
    allowing condition functions to access dependencies by name.

    Args:
        wf: The workflow to build the namespace for.
        outputs: Dictionary of workflow name -> output value.

    Returns:
        A SimpleNamespace with dependency values as attributes.
    """
    data: dict[str, Any] = {}
    for param_name, param_type in wf.input_types.items():
        if param_name in wf.bound_args:
            data[param_name] = wf.bound_args[param_name]
            continue
        if param_name in wf.bound_deps:
            deps = wf.bound_deps[param_name]
            if wf.input_is_list.get(param_name, False):
                data[param_name] = [outputs.get(dep.name) for dep in deps]
            else:
                data[param_name] = outputs.get(deps[0].name) if deps else None
            continue
        dep_wf = get_workflow_by_output(param_type)
        if dep_wf is None:
            continue
        if wf.input_is_list.get(param_name, False):
            data[param_name] = [outputs.get(dep_wf.name)]
        else:
            data[param_name] = outputs.get(dep_wf.name)
    return SimpleNamespace(**data)


async def prompt_for_approval(message: str) -> bool:
    """Prompt the user for approval via stdin.

    This is the shared implementation used by both graph.py and executor.py
    for interactive approval prompts.

    Args:
        message: The approval message to display to the user.

    Returns:
        True if the user approves, False otherwise.
    """
    prompt = f"{message}\n\nProceed? [y/N]: "
    response = await asyncio.to_thread(input, prompt)
    return response.strip().lower() in {"y", "yes"}
