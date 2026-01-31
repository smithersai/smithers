"""Graph building and execution."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Iterable
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from smithers._shared import build_kwargs as _build_kwargs
from smithers._shared import compute_cache_key as _cache_key
from smithers._shared import dependency_namespace as _dependency_namespace
from smithers._shared import hash_inputs as _hash_inputs
from smithers._shared import normalize_invalidate as _normalize_invalidate
from smithers._shared import resolve_workflow as _resolve_workflow
from smithers._shared import validate_output as _validate_output
from smithers.cache import Cache, SqliteCache
from smithers.conditions import (
    ConditionNotMetError,
    evaluate_condition,
    get_condition_policy,
)
from smithers.config import get_config
from smithers.errors import ApprovalRejected, WorkflowError
from smithers.types import (
    ApprovalRecord,
    DryRunPlan,
    ExecutionResult,
    ExecutionStats,
    WorkflowEvent,
    WorkflowGraph,
    WorkflowNode,
    WorkflowResult,
)
from smithers.workflow import SkipResult, Workflow, get_workflow_by_output


def build_graph(target: Workflow) -> WorkflowGraph:
    """
    Build an execution graph from a target workflow.

    Walks the dependency tree by inspecting type hints and builds
    a graph with nodes, edges, and parallelization levels.

    Example:
        graph = build_graph(deploy_workflow)
        print(graph.mermaid())
    """
    nodes: dict[str, WorkflowNode] = {}
    edges: set[tuple[str, str]] = set()
    workflows: dict[str, Workflow] = {}

    def visit(wf: Workflow) -> None:
        """Recursively visit workflow and its dependencies."""
        if wf.name in nodes:
            return

        # Check for self-referential cycle before processing dependencies
        # A workflow that depends on its own output type creates a cycle
        if wf.name in workflows:
            raise ValueError(
                f"Workflow '{wf.name}' has a self-referential cycle: "
                f"it depends on its own output type {wf.output_type.__name__}"
            )

        workflows[wf.name] = wf

        dep_names: set[str] = set()
        for param_name, param_type in wf.input_types.items():
            deps = _resolve_dependencies_for_param(wf, param_name, param_type)
            if deps is None:
                continue
            if not wf.input_is_list.get(param_name, False) and len(deps) > 1:
                raise ValueError(
                    f"Workflow '{wf.name}' expects a single dependency for '{param_name}'"
                )
            for dep_wf in deps:
                visit(dep_wf)
                dep_names.add(dep_wf.name)
                edges.add((dep_wf.name, wf.name))

        # Create node
        nodes[wf.name] = WorkflowNode(
            name=wf.name,
            output_type=wf.output_type,
            dependencies=sorted(dep_names),
            requires_approval=wf.requires_approval,
            approval_message=wf.approval_message,
        )

    visit(target)

    # Compute levels (topological sort with parallelization)
    levels = _compute_levels(nodes)

    return WorkflowGraph(
        root=target.name,
        nodes=nodes,
        edges=sorted(edges),
        levels=levels,
        workflows=workflows,
    )


def _compute_levels(nodes: dict[str, WorkflowNode]) -> list[list[str]]:
    """
    Compute execution levels for parallel execution.

    Nodes in the same level can run in parallel.

    Uses Kahn's algorithm with a precomputed dependents map for O(n + e)
    complexity where n is the number of nodes and e is the number of edges.
    """
    in_degree: dict[str, int] = {name: 0 for name in nodes}

    # Build a reverse dependency map: node -> list of nodes that depend on it
    # This avoids O(n) lookup per node when updating in-degrees
    dependents: dict[str, list[str]] = {name: [] for name in nodes}

    for node in nodes.values():
        in_degree[node.name] = len(node.dependencies)
        for dep in node.dependencies:
            if dep in dependents:
                dependents[dep].append(node.name)

    levels: list[list[str]] = []
    remaining = set(nodes.keys())

    while remaining:
        # Find all nodes with no remaining dependencies
        level = [name for name in remaining if in_degree[name] == 0]
        if not level:
            # Circular dependency
            raise ValueError(f"Circular dependency detected among: {remaining}")

        levels.append(sorted(level))

        # Remove this level and update in-degrees
        for name in level:
            remaining.remove(name)
            # Decrease in-degree of nodes that depend on this one (O(1) lookup)
            for dependent in dependents[name]:
                in_degree[dependent] -= 1

    return levels


async def run_graph(
    graph: WorkflowGraph,
    cache: Cache | None = None,
    max_concurrency: int | None = None,
    *,
    fail_fast: bool = False,
    return_all: bool = False,
    dry_run: bool = False,
    invalidate: Iterable[str | Workflow] | str | Workflow | None = None,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None = None,
    auto_approve: bool | Iterable[str] = False,
    on_rejection: str = "fail",
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
) -> Any:
    """
    Execute a workflow graph.

    Runs workflows level by level, with workflows in the same level
    executing in parallel.

    Args:
        graph: The workflow graph to execute
        cache: Optional cache for skipping unchanged workflows
        max_concurrency: Maximum number of concurrent workflows (default: unlimited)
        invalidate: Workflow names or Workflow objects to force re-execution

    Returns:
        The output of the root workflow
    """
    if dry_run:
        workflows = [name for level in graph.levels for name in level]
        return DryRunPlan(workflows=workflows, levels=graph.levels)

    if max_concurrency is None:
        max_concurrency = get_config().max_concurrency

    invalidated = _normalize_invalidate(invalidate)
    outputs: dict[str, Any] = {}
    results: list[WorkflowResult] = []
    approvals: list[ApprovalRecord] = []
    statuses: dict[str, str] = {}
    errors: dict[str, BaseException] = {}

    semaphore = asyncio.Semaphore(max_concurrency) if max_concurrency else None
    start_time = time.perf_counter()

    async def run_node(name: str) -> None:
        node = graph.nodes[name]
        wf = _resolve_workflow(graph, node)

        # Skip if dependencies failed or skipped
        for dep in node.dependencies:
            if statuses.get(dep) in {"failed", "skipped"}:
                statuses[name] = "skipped"
                outputs[name] = None
                return

        if on_progress:
            await on_progress(WorkflowEvent(type="started", workflow_name=name))

        try:
            # Check condition (if any) before proceeding
            condition_policy = wf.condition_policy or get_condition_policy(wf.fn)
            if condition_policy is not None:
                deps_namespace = _dependency_namespace(wf, outputs)
                condition_met = evaluate_condition(condition_policy, deps_namespace)

                if not condition_met:
                    skip_reason = condition_policy.skip_reason
                    on_skip_action = condition_policy.on_skip

                    if on_skip_action == "fail":
                        raise ConditionNotMetError(name, skip_reason)
                    elif on_skip_action == "default":
                        default_val = condition_policy.default_value
                        outputs[name] = default_val
                        statuses[name] = "skipped"
                        results.append(
                            WorkflowResult(
                                name=name,
                                output=default_val,
                                cached=False,
                                duration_ms=0.0,
                            )
                        )
                        if on_progress:
                            await on_progress(
                                WorkflowEvent(
                                    type="skipped",
                                    workflow_name=name,
                                    message=f"Condition not met: {skip_reason}",
                                )
                            )
                        return
                    else:
                        # Default: skip
                        outputs[name] = None
                        statuses[name] = "skipped"
                        results.append(
                            WorkflowResult(
                                name=name,
                                output=None,
                                cached=False,
                                duration_ms=0.0,
                            )
                        )
                        if on_progress:
                            await on_progress(
                                WorkflowEvent(
                                    type="skipped",
                                    workflow_name=name,
                                    message=f"Condition not met: {skip_reason}",
                                )
                            )
                        return

            cache_key = None
            input_hash = None
            if cache is not None and name not in invalidated and "*" not in invalidated:
                input_hash = _hash_inputs(wf, outputs)
                cache_key = _cache_key(wf, input_hash)
                cached_value = await cache.get(cache_key)
                if cached_value is not None:
                    outputs[name] = cached_value
                    statuses[name] = "cached"
                    results.append(
                        WorkflowResult(
                            name=name,
                            output=cached_value,
                            cached=True,
                            duration_ms=0.0,
                        )
                    )
                    if on_progress:
                        await on_progress(WorkflowEvent(type="cached", workflow_name=name))
                    return

            approved = await _maybe_require_approval(
                wf,
                node,
                outputs,
                approval_handler=approval_handler,
                auto_approve=auto_approve,
                on_rejection=on_rejection,
                approvals=approvals,
            )
            if not approved:
                statuses[name] = "skipped"
                outputs[name] = None
                results.append(
                    WorkflowResult(
                        name=name,
                        output=None,
                        cached=False,
                        duration_ms=0.0,
                    )
                )
                if on_progress:
                    await on_progress(
                        WorkflowEvent(
                            type="skipped",
                            workflow_name=name,
                            message="Approval rejected",
                        )
                    )
                return

            start = time.perf_counter()
            kwargs = _build_kwargs(wf, outputs)
            output = await wf(**kwargs)
            duration_ms = (time.perf_counter() - start) * 1000.0

            if isinstance(output, SkipResult):
                outputs[name] = None
                statuses[name] = "skipped"
                results.append(
                    WorkflowResult(
                        name=name,
                        output=None,
                        cached=False,
                        duration_ms=duration_ms,
                    )
                )
                if on_progress:
                    await on_progress(
                        WorkflowEvent(
                            type="skipped",
                            workflow_name=name,
                            duration_ms=duration_ms,
                            message=output.reason,
                        )
                    )
                return

            validated = _validate_output(wf, output)
            outputs[name] = validated
            statuses[name] = "success"
            results.append(
                WorkflowResult(
                    name=name,
                    output=validated,
                    cached=False,
                    duration_ms=duration_ms,
                )
            )

            if cache is not None and cache_key is not None:
                if isinstance(cache, SqliteCache):
                    await cache.set(
                        cache_key, validated, workflow_name=wf.name, input_hash=input_hash
                    )
                else:
                    await cache.set(cache_key, validated)

            if on_progress:
                await on_progress(
                    WorkflowEvent(
                        type="completed",
                        workflow_name=name,
                        duration_ms=duration_ms,
                    )
                )
        except ApprovalRejected as exc:
            statuses[name] = "skipped"
            outputs[name] = None
            errors[name] = exc
            if on_rejection == "fail":
                raise
        except BaseException as exc:
            statuses[name] = "failed"
            errors[name] = exc
            if on_progress:
                await on_progress(
                    WorkflowEvent(
                        type="failed",
                        workflow_name=name,
                        message=str(exc),
                    )
                )
            if fail_fast:
                raise

    async def run_node_with_semaphore(name: str) -> None:
        if semaphore is None:
            await run_node(name)
            return
        async with semaphore:
            await run_node(name)

    for level in graph.levels:
        tasks = [asyncio.create_task(run_node_with_semaphore(name)) for name in level]
        if not tasks:
            continue
        if fail_fast:
            # In fail_fast mode, gather will raise the first exception encountered
            # but we want to wrap it in WorkflowError for consistency
            try:
                await asyncio.gather(*tasks)
            except ApprovalRejected:
                raise
            except WorkflowError:
                raise
            except BaseException:
                # If errors dict is populated, we'll raise WorkflowError below
                # Otherwise, continue to check for errors
                if errors:
                    break
                raise
        else:
            await asyncio.gather(*tasks, return_exceptions=False)

    if errors:
        first_name = next(iter(errors.keys()))
        raise WorkflowError(
            first_name,
            errors[first_name],
            completed=[
                name for name, status in statuses.items() if status in {"success", "cached"}
            ],
            errors=errors,
        )

    total_duration = (time.perf_counter() - start_time) * 1000.0
    stats = ExecutionStats(
        total_duration_ms=total_duration,
        workflows_executed=sum(1 for result in results if not result.cached),
        workflows_cached=sum(1 for result in results if result.cached),
        tokens_used=0,
    )

    root_output = outputs.get(graph.root)
    if return_all:
        return ExecutionResult(
            output=root_output,
            outputs=outputs,
            results=results,
            stats=stats,
            approvals=approvals,
        )

    return root_output


def _resolve_dependencies_for_param(
    wf: Workflow, param_name: str, param_type: type[BaseModel]
) -> list[Workflow] | None:
    if param_name in wf.bound_deps:
        return wf.bound_deps[param_name]
    if param_name in wf.bound_args:
        return None
    dep_wf = get_workflow_by_output(param_type)
    if dep_wf is None:
        raise ValueError(
            f"Workflow '{wf.name}' depends on {param_type.__name__}, "
            f"but no workflow produces that type"
        )
    return [dep_wf]


async def _maybe_require_approval(
    wf: Workflow,
    node: WorkflowNode,
    outputs: dict[str, Any],
    *,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None,
    auto_approve: bool | Iterable[str],
    on_rejection: str,
    approvals: list[ApprovalRecord],
) -> bool:
    if not wf.requires_approval:
        return True

    if auto_approve is True or (
        not isinstance(auto_approve, str)
        and isinstance(auto_approve, Iterable)
        and wf.name in set(auto_approve)
    ):
        approvals.append(
            ApprovalRecord(
                workflow_name=wf.name,
                decision=True,
                timestamp=datetime.now(UTC),
                message=node.approval_message or "Approval granted",
            )
        )
        return True

    message = node.approval_message or f"Approve workflow '{wf.name}'?"
    if wf.approval_context is not None:
        context = wf.approval_context(_dependency_namespace(wf, outputs))
        message = f"{message}\n\n{context}"

    approved = False
    if approval_handler is not None:
        if wf.approval_timeout is not None:
            approved = await asyncio.wait_for(
                approval_handler(wf.name, message),
                timeout=wf.approval_timeout.total_seconds(),
            )
        else:
            approved = await approval_handler(wf.name, message)
    else:
        if wf.approval_timeout is not None:
            approved = await asyncio.wait_for(
                _prompt_for_approval(message),
                timeout=wf.approval_timeout.total_seconds(),
            )
        else:
            approved = await _prompt_for_approval(message)

    approvals.append(
        ApprovalRecord(
            workflow_name=wf.name,
            decision=approved,
            timestamp=datetime.now(UTC),
            message=message,
        )
    )

    if not approved:
        if on_rejection == "skip":
            return False
        raise ApprovalRejected(wf.name, "Approval rejected")

    return True


async def _prompt_for_approval(message: str) -> bool:
    prompt = f"{message}\n\nProceed? [y/N]: "
    response = await asyncio.to_thread(input, prompt)
    return response.strip().lower() in {"y", "yes"}
