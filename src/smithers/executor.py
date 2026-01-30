"""Execution engine with full SqliteStore integration.

This module provides the execution infrastructure that integrates with SqliteStore
to enable constant visibility, run tracking, and execution ledger functionality
as described in ARCHITECTURE.md.

The engine:
- Creates Run and RunNode records in SQLite
- Emits events throughout execution
- Tracks LLM and tool calls via RuntimeContext
- Supports pause/resume via approvals

The executor automatically sets RuntimeContext before executing each workflow,
enabling transparent tracking of all Claude API calls and tool invocations.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from pydantic import TypeAdapter

from smithers.cache import Cache, SqliteCache
from smithers.errors import ApprovalRejected, WorkflowError
from smithers.hashing import code_hash, hash_json
from smithers.hashing import input_hash as compute_input_hash
from smithers.runtime import RuntimeContext, runtime_context
from smithers.store.sqlite import NodeStatus, RunStatus, SqliteStore
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

if TYPE_CHECKING:
    pass


@dataclass
class ExecutionContext:
    """Context for a single graph execution."""

    graph: WorkflowGraph
    run_id: str
    store: SqliteStore | None = None
    cache: Cache | None = None
    outputs: dict[str, Any] = field(default_factory=dict)
    statuses: dict[str, str] = field(default_factory=dict)
    errors: dict[str, BaseException] = field(default_factory=dict)
    results: list[WorkflowResult] = field(default_factory=list)
    approvals: list[ApprovalRecord] = field(default_factory=list)


class PauseExecution(Exception):
    """Raised to indicate the run should pause for an approval."""

    def __init__(self, node_id: str, message: str) -> None:
        self.node_id = node_id
        self.message = message
        super().__init__(f"Execution paused for approval of node '{node_id}'")


async def run_graph_with_store(
    graph: WorkflowGraph,
    *,
    store: SqliteStore | None = None,
    cache: Cache | None = None,
    max_concurrency: int | None = None,
    fail_fast: bool = False,
    return_all: bool = False,
    dry_run: bool = False,
    invalidate: Iterable[str] | str | None = None,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None = None,
    auto_approve: bool | Iterable[str] = False,
    on_rejection: str = "fail",
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
    run_id: str | None = None,
    headless: bool = False,
) -> Any:
    """
    Execute a workflow graph with full SqliteStore integration.

    This function extends run_graph with complete execution tracking:
    - Creates a Run record in SQLite
    - Creates RunNode records for each node
    - Emits events throughout execution
    - Tracks node status transitions

    Args:
        graph: The workflow graph to execute
        store: SqliteStore for execution tracking (creates in-memory if None)
        cache: Optional cache for skipping unchanged workflows
        max_concurrency: Maximum number of concurrent workflows
        fail_fast: Stop execution on first failure
        return_all: Return full ExecutionResult instead of just root output
        dry_run: Return execution plan without running
        invalidate: Workflow names to force re-execution
        approval_handler: Custom approval handler
        auto_approve: Auto-approve workflows
        on_rejection: Behavior on rejection ("fail" or "skip")
        on_progress: Progress callback
        run_id: Custom run ID (generated if None)
        headless: If True, pause execution when approval is required instead of prompting

    Returns:
        The output of the root workflow (or ExecutionResult if return_all=True)

    Raises:
        PauseExecution: If headless=True and an approval is required
    """
    from smithers.config import get_config

    if dry_run:
        workflows = [name for level in graph.levels for name in level]
        return DryRunPlan(workflows=workflows, levels=graph.levels)

    if max_concurrency is None:
        max_concurrency = get_config().max_concurrency

    # Initialize store if not provided
    if store is None:
        # Use an in-memory store for minimal tracking
        import tempfile

        store = SqliteStore(f"{tempfile.gettempdir()}/smithers_run_{id(graph)}.db")

    await store.initialize()

    # Create the run record
    run_id = await store.create_run(graph, run_id=run_id)

    # Update run status to RUNNING
    await store.update_run_status(run_id, RunStatus.RUNNING)
    await store.emit_event(run_id, None, "RunStarted", {"target": graph.root})

    invalidated = _normalize_invalidate(invalidate)

    ctx = ExecutionContext(
        graph=graph,
        run_id=run_id,
        store=store,
        cache=cache,
    )

    semaphore = asyncio.Semaphore(max_concurrency) if max_concurrency else None
    start_time = time.perf_counter()

    async def run_node_in_main(name: str) -> None:
        """Node executor for run_graph_with_store."""
        node = graph.nodes[name]
        wf = _resolve_workflow(graph, node)

        # Check dependencies
        for dep in node.dependencies:
            if ctx.statuses.get(dep) in {"failed", "skipped"}:
                ctx.statuses[name] = "skipped"
                ctx.outputs[name] = None
                await store.update_node_status(
                    run_id, name, NodeStatus.SKIPPED, skip_reason="dependency failed"
                )
                await store.emit_event(
                    run_id, name, "NodeSkipped", {"reason": "dependency failed"}
                )
                return

        # Emit NodeReady event
        await store.update_node_status(run_id, name, NodeStatus.READY)
        await store.emit_event(run_id, name, "NodeReady", {})

        if on_progress:
            await on_progress(WorkflowEvent(type="started", workflow_name=name))

        try:
            # Check cache
            cache_key = None
            input_hash_value = None
            if cache is not None and name not in invalidated and "*" not in invalidated:
                input_hash_value = _hash_inputs(wf, ctx.outputs)
                cache_key = _cache_key(wf, input_hash_value)
                cached_value = await cache.get(cache_key)
                if cached_value is not None:
                    ctx.outputs[name] = cached_value
                    ctx.statuses[name] = "cached"
                    ctx.results.append(
                        WorkflowResult(
                            name=name, output=cached_value, cached=True, duration_ms=0.0
                        )
                    )
                    await store.update_node_status(
                        run_id, name, NodeStatus.CACHED, cache_key=cache_key
                    )
                    # Store cached output for potential resume
                    cached_to_store = cached_value.model_dump() if hasattr(cached_value, "model_dump") else cached_value
                    await store.store_node_output(run_id, name, cached_to_store)
                    await store.emit_event(
                        run_id, name, "NodeCached", {"cache_key": cache_key}
                    )
                    if on_progress:
                        await on_progress(
                            WorkflowEvent(type="cached", workflow_name=name)
                        )
                    return

            # Handle approval
            approved = await _maybe_require_approval(
                wf,
                node,
                ctx.outputs,
                run_id=run_id,
                store=store,
                approval_handler=approval_handler,
                auto_approve=auto_approve,
                on_rejection=on_rejection,
                approvals=ctx.approvals,
                headless=headless,
            )
            if not approved:
                ctx.statuses[name] = "skipped"
                ctx.outputs[name] = None
                ctx.results.append(
                    WorkflowResult(name=name, output=None, cached=False, duration_ms=0.0)
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

            # Execute the workflow with RuntimeContext for LLM/tool tracking
            await store.update_node_status(run_id, name, NodeStatus.RUNNING)
            await store.emit_event(run_id, name, "NodeStarted", {})

            start = time.perf_counter()
            kwargs = _build_kwargs(wf, ctx.outputs)

            # Set up RuntimeContext for LLM and tool call tracking
            rt_ctx = RuntimeContext(run_id=run_id, node_id=name, store=store)
            with runtime_context(rt_ctx):
                output = await wf(**kwargs)

            duration_ms = (time.perf_counter() - start) * 1000.0

            if isinstance(output, SkipResult):
                ctx.outputs[name] = None
                ctx.statuses[name] = "skipped"
                ctx.results.append(
                    WorkflowResult(
                        name=name, output=None, cached=False, duration_ms=duration_ms
                    )
                )
                await store.update_node_status(
                    run_id, name, NodeStatus.SKIPPED, skip_reason=output.reason
                )
                await store.emit_event(
                    run_id, name, "NodeSkipped", {"reason": output.reason}
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
            ctx.outputs[name] = validated
            ctx.statuses[name] = "success"
            ctx.results.append(
                WorkflowResult(
                    name=name, output=validated, cached=False, duration_ms=duration_ms
                )
            )

            # Store in cache
            if cache is not None and cache_key is not None:
                if isinstance(cache, SqliteCache):
                    await cache.set(
                        cache_key,
                        validated,
                        workflow_name=wf.name,
                        input_hash=input_hash_value,
                    )
                else:
                    await cache.set(cache_key, validated)

            await store.update_node_status(
                run_id,
                name,
                NodeStatus.SUCCESS,
                cache_key=cache_key,
                output_hash=hash_json(
                    validated.model_dump() if hasattr(validated, "model_dump") else validated
                ),
            )
            # Store node output for potential resume
            output_to_store = validated.model_dump() if hasattr(validated, "model_dump") else validated
            await store.store_node_output(run_id, name, output_to_store)
            await store.emit_event(
                run_id,
                name,
                "NodeFinished",
                {"duration_ms": duration_ms, "cached": False},
            )

            if on_progress:
                await on_progress(
                    WorkflowEvent(
                        type="completed", workflow_name=name, duration_ms=duration_ms
                    )
                )

        except PauseExecution:
            # Re-raise PauseExecution to be handled at the outer level
            raise

        except ApprovalRejected as exc:
            ctx.statuses[name] = "skipped"
            ctx.outputs[name] = None
            ctx.errors[name] = exc
            await store.update_node_status(
                run_id, name, NodeStatus.SKIPPED, skip_reason="approval rejected"
            )
            await store.emit_event(
                run_id, name, "NodeSkipped", {"reason": "approval rejected"}
            )
            if on_rejection == "fail":
                raise

        except BaseException as exc:
            ctx.statuses[name] = "failed"
            ctx.errors[name] = exc
            await store.update_node_status(run_id, name, NodeStatus.FAILED, error=exc)
            await store.emit_event(
                run_id,
                name,
                "NodeFailed",
                {"error": str(exc), "error_type": type(exc).__name__},
            )
            if on_progress:
                await on_progress(
                    WorkflowEvent(type="failed", workflow_name=name, message=str(exc))
                )
            if fail_fast:
                raise

    async def run_node_with_semaphore_main(name: str) -> None:
        if semaphore is None:
            await run_node_in_main(name)
            return
        async with semaphore:
            await run_node_in_main(name)

    # Execute level by level for run_graph_with_store
    try:
        for level in graph.levels:
            tasks = [
                asyncio.create_task(run_node_with_semaphore_main(name)) for name in level
            ]
            if not tasks:
                continue

            if fail_fast:
                try:
                    await asyncio.gather(*tasks)
                except ApprovalRejected:
                    raise
                except WorkflowError:
                    raise
                except PauseExecution:
                    raise
                except BaseException:
                    if ctx.errors:
                        break
                    raise
            else:
                await asyncio.gather(*tasks, return_exceptions=False)
    except PauseExecution as exc:
        # Update run status to PAUSED and node status to PAUSED
        await store.update_node_status(run_id, exc.node_id, NodeStatus.PAUSED)
        await store.update_run_status(run_id, RunStatus.PAUSED)
        await store.emit_event(
            run_id, exc.node_id, "RunPaused", {"node_id": exc.node_id, "message": exc.message}
        )
        raise
    except BaseException:
        # Update run status to FAILED
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await store.emit_event(run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        raise

    # Check for errors
    if ctx.errors:
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await store.emit_event(run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        first_name = next(iter(ctx.errors.keys()))
        raise WorkflowError(
            first_name,
            ctx.errors[first_name],
            completed=[
                name
                for name, status in ctx.statuses.items()
                if status in {"success", "cached"}
            ],
            errors=ctx.errors,
        )

    # Mark run as successful
    await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)
    await store.emit_event(run_id, None, "RunFinished", {})

    total_duration = (time.perf_counter() - start_time) * 1000.0
    stats = ExecutionStats(
        total_duration_ms=total_duration,
        workflows_executed=sum(1 for result in ctx.results if not result.cached),
        workflows_cached=sum(1 for result in ctx.results if result.cached),
        tokens_used=0,
    )

    root_output = ctx.outputs.get(graph.root)
    if return_all:
        return ExecutionResult(
            output=root_output,
            outputs=ctx.outputs,
            results=ctx.results,
            stats=stats,
            approvals=ctx.approvals,
        )

    return root_output


# Helper functions (duplicated from graph.py for now - could be refactored to shared module)


def _normalize_invalidate(invalidate: Iterable[str] | str | None) -> set[str]:
    if invalidate is None:
        return set()
    if isinstance(invalidate, str):
        return {invalidate}
    return set(invalidate)


def _resolve_workflow(graph: WorkflowGraph, node: WorkflowNode) -> Workflow:
    if node.name in graph.workflows:
        return graph.workflows[node.name]
    wf = get_workflow_by_output(node.output_type)
    if wf is None:
        raise ValueError(f"No workflow registered for output type {node.output_type.__name__}")
    return wf


def _build_kwargs(wf: Workflow, outputs: dict[str, Any]) -> dict[str, Any]:
    kwargs = dict(wf.bound_args)
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
            raise ValueError(
                f"Workflow '{wf.name}' depends on {param_type.__name__}, "
                f"but no workflow produces that type"
            )
        if wf.input_is_list.get(param_name, False):
            kwargs[param_name] = [outputs[dep_wf.name]]
        else:
            kwargs[param_name] = outputs[dep_wf.name]

    return kwargs


def _validate_output(wf: Workflow, output: Any) -> Any:
    if output is None and wf.output_optional:
        return None
    adapter = TypeAdapter(wf.output_type)
    return adapter.validate_python(output)


def _hash_inputs(wf: Workflow, outputs: dict[str, Any]) -> str:
    inputs: dict[str, Any] = {}
    inputs["bound_args"] = wf.bound_args
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
        deps[param_name] = outputs[dep_wf.name]
    inputs["deps"] = deps
    return compute_input_hash(inputs)


def _cache_key(wf: Workflow, input_hash_value: str) -> str:
    return hash_json(
        {
            "workflow_name": wf.name,
            "code_hash": code_hash(wf),
            "input_hash": input_hash_value,
        }
    )


async def _maybe_require_approval(
    wf: Workflow,
    node: WorkflowNode,
    outputs: dict[str, Any],
    *,
    run_id: str,
    store: SqliteStore,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None,
    auto_approve: bool | Iterable[str],
    on_rejection: str,
    approvals: list[ApprovalRecord],
    headless: bool = False,
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

    # Check if approval already exists (for resumed runs)
    existing_approval = await store.get_approval(run_id, wf.name)
    if existing_approval is not None and existing_approval.status != "PENDING":
        approved = existing_approval.status == "APPROVED"
        approvals.append(
            ApprovalRecord(
                workflow_name=wf.name,
                decision=approved,
                timestamp=existing_approval.decided_at or datetime.now(UTC),
                message=message,
            )
        )
        if not approved and on_rejection == "fail":
            raise ApprovalRejected(wf.name, "Approval rejected")
        return approved

    # Record approval request in store (if not already present)
    if existing_approval is None:
        await store.request_approval(run_id, wf.name, message)
        await store.emit_event(run_id, wf.name, "ApprovalRequested", {"prompt": message})

    # In headless mode, pause execution instead of prompting
    if headless and approval_handler is None:
        raise PauseExecution(wf.name, message)

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

    # Record decision in store
    await store.decide_approval(run_id, wf.name, approved)
    await store.emit_event(
        run_id, wf.name, "ApprovalDecided", {"approved": approved}
    )

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


def _dependency_namespace(wf: Workflow, outputs: dict[str, Any]) -> SimpleNamespace:
    data: dict[str, Any] = {}
    for param_name, param_type in wf.input_types.items():
        if param_name in wf.bound_args:
            data[param_name] = wf.bound_args[param_name]
            continue
        if param_name in wf.bound_deps:
            deps = wf.bound_deps[param_name]
            data[param_name] = [outputs[dep.name] for dep in deps]
            continue
        dep_wf = get_workflow_by_output(param_type)
        if dep_wf is None:
            continue
        data[param_name] = outputs.get(dep_wf.name)
    return SimpleNamespace(**data)


async def resume_run(
    run_id: str,
    store: SqliteStore,
    graph: WorkflowGraph,
    *,
    cache: Cache | None = None,
    max_concurrency: int | None = None,
    fail_fast: bool = False,
    return_all: bool = False,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None = None,
    auto_approve: bool | Iterable[str] = False,
    on_rejection: str = "fail",
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
) -> Any:
    """
    Resume a paused execution run.

    This function resumes execution of a previously paused run, restoring
    the completed node outputs and continuing from where the run left off.

    Args:
        run_id: The ID of the run to resume
        store: SqliteStore containing the run state
        graph: The workflow graph (must match the original run)
        cache: Optional cache for skipping unchanged workflows
        max_concurrency: Maximum number of concurrent workflows
        fail_fast: Stop execution on first failure
        return_all: Return full ExecutionResult instead of just root output
        approval_handler: Custom approval handler
        auto_approve: Auto-approve workflows
        on_rejection: Behavior on rejection ("fail" or "skip")
        on_progress: Progress callback

    Returns:
        The output of the root workflow (or ExecutionResult if return_all=True)

    Raises:
        ValueError: If run not found, not paused, or has pending approvals
    """
    from smithers.config import get_config

    await store.initialize()

    # Get the run
    run = await store.get_run(run_id)
    if run is None:
        raise ValueError(f"Run not found: {run_id}")

    if run.status != RunStatus.PAUSED:
        raise ValueError(f"Run is not paused (status: {run.status.value})")

    # Check for pending approvals
    pending_approvals = await store.get_pending_approvals(run_id)
    if pending_approvals:
        node_ids = [a.node_id for a in pending_approvals]
        raise ValueError(f"Cannot resume: pending approvals for nodes: {', '.join(node_ids)}")

    if max_concurrency is None:
        max_concurrency = get_config().max_concurrency

    # Restore completed node outputs
    stored_outputs = await store.get_all_node_outputs(run_id)
    nodes = await store.get_run_nodes(run_id)

    # Build context with restored outputs
    ctx = ExecutionContext(
        graph=graph,
        run_id=run_id,
        store=store,
        cache=cache,
    )

    # Restore completed node outputs and statuses
    # We need to deserialize the outputs to their proper Pydantic models
    for node in nodes:
        if node.status in (NodeStatus.SUCCESS, NodeStatus.CACHED):
            if node.node_id in stored_outputs:
                raw_output = stored_outputs[node.node_id]
                # Deserialize to the proper Pydantic model
                graph_node = graph.nodes.get(node.node_id)
                if graph_node is not None and raw_output is not None:
                    adapter = TypeAdapter(graph_node.output_type)
                    ctx.outputs[node.node_id] = adapter.validate_python(raw_output)
                else:
                    ctx.outputs[node.node_id] = raw_output
                ctx.statuses[node.node_id] = "success" if node.status == NodeStatus.SUCCESS else "cached"
        elif node.status == NodeStatus.SKIPPED:
            ctx.outputs[node.node_id] = None
            ctx.statuses[node.node_id] = "skipped"
        elif node.status == NodeStatus.FAILED:
            ctx.statuses[node.node_id] = "failed"

    # Update run status to RUNNING
    await store.update_run_status(run_id, RunStatus.RUNNING)
    await store.emit_event(run_id, None, "RunResumed", {"restored_nodes": list(stored_outputs.keys())})

    semaphore = asyncio.Semaphore(max_concurrency) if max_concurrency else None
    start_time = time.perf_counter()

    async def run_node(name: str) -> None:
        # Skip if already completed
        if ctx.statuses.get(name) in {"success", "cached", "skipped"}:
            return

        node = graph.nodes[name]
        wf = _resolve_workflow(graph, node)

        # Check dependencies
        for dep in node.dependencies:
            if ctx.statuses.get(dep) in {"failed", "skipped"}:
                ctx.statuses[name] = "skipped"
                ctx.outputs[name] = None
                await store.update_node_status(
                    run_id, name, NodeStatus.SKIPPED, skip_reason="dependency failed"
                )
                await store.emit_event(
                    run_id, name, "NodeSkipped", {"reason": "dependency failed"}
                )
                return

        # Emit NodeReady event
        await store.update_node_status(run_id, name, NodeStatus.READY)
        await store.emit_event(run_id, name, "NodeReady", {})

        if on_progress:
            await on_progress(WorkflowEvent(type="started", workflow_name=name))

        try:
            # Check cache
            cache_key = None
            input_hash_value = None
            if cache is not None:
                input_hash_value = _hash_inputs(wf, ctx.outputs)
                cache_key = _cache_key(wf, input_hash_value)
                cached_value = await cache.get(cache_key)
                if cached_value is not None:
                    ctx.outputs[name] = cached_value
                    ctx.statuses[name] = "cached"
                    ctx.results.append(
                        WorkflowResult(
                            name=name, output=cached_value, cached=True, duration_ms=0.0
                        )
                    )
                    await store.update_node_status(
                        run_id, name, NodeStatus.CACHED, cache_key=cache_key
                    )
                    cached_to_store = cached_value.model_dump() if hasattr(cached_value, "model_dump") else cached_value
                    await store.store_node_output(run_id, name, cached_to_store)
                    await store.emit_event(
                        run_id, name, "NodeCached", {"cache_key": cache_key}
                    )
                    if on_progress:
                        await on_progress(
                            WorkflowEvent(type="cached", workflow_name=name)
                        )
                    return

            # Handle approval
            approved = await _maybe_require_approval(
                wf,
                node,
                ctx.outputs,
                run_id=run_id,
                store=store,
                approval_handler=approval_handler,
                auto_approve=auto_approve,
                on_rejection=on_rejection,
                approvals=ctx.approvals,
            )
            if not approved:
                ctx.statuses[name] = "skipped"
                ctx.outputs[name] = None
                ctx.results.append(
                    WorkflowResult(name=name, output=None, cached=False, duration_ms=0.0)
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

            # Execute the workflow with RuntimeContext for LLM/tool tracking
            await store.update_node_status(run_id, name, NodeStatus.RUNNING)
            await store.emit_event(run_id, name, "NodeStarted", {})

            start = time.perf_counter()
            kwargs = _build_kwargs(wf, ctx.outputs)

            # Set up RuntimeContext for LLM and tool call tracking
            rt_ctx = RuntimeContext(run_id=run_id, node_id=name, store=store)
            with runtime_context(rt_ctx):
                output = await wf(**kwargs)

            duration_ms = (time.perf_counter() - start) * 1000.0

            if isinstance(output, SkipResult):
                ctx.outputs[name] = None
                ctx.statuses[name] = "skipped"
                ctx.results.append(
                    WorkflowResult(
                        name=name, output=None, cached=False, duration_ms=duration_ms
                    )
                )
                await store.update_node_status(
                    run_id, name, NodeStatus.SKIPPED, skip_reason=output.reason
                )
                await store.emit_event(
                    run_id, name, "NodeSkipped", {"reason": output.reason}
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
            ctx.outputs[name] = validated
            ctx.statuses[name] = "success"
            ctx.results.append(
                WorkflowResult(
                    name=name, output=validated, cached=False, duration_ms=duration_ms
                )
            )

            # Store in cache
            if cache is not None and cache_key is not None:
                if isinstance(cache, SqliteCache):
                    await cache.set(
                        cache_key,
                        validated,
                        workflow_name=wf.name,
                        input_hash=input_hash_value,
                    )
                else:
                    await cache.set(cache_key, validated)

            await store.update_node_status(
                run_id,
                name,
                NodeStatus.SUCCESS,
                cache_key=cache_key,
                output_hash=hash_json(
                    validated.model_dump() if hasattr(validated, "model_dump") else validated
                ),
            )
            # Store node output for potential resume
            output_to_store = validated.model_dump() if hasattr(validated, "model_dump") else validated
            await store.store_node_output(run_id, name, output_to_store)
            await store.emit_event(
                run_id,
                name,
                "NodeFinished",
                {"duration_ms": duration_ms, "cached": False},
            )

            if on_progress:
                await on_progress(
                    WorkflowEvent(
                        type="completed", workflow_name=name, duration_ms=duration_ms
                    )
                )

        except ApprovalRejected as exc:
            ctx.statuses[name] = "skipped"
            ctx.outputs[name] = None
            ctx.errors[name] = exc
            await store.update_node_status(
                run_id, name, NodeStatus.SKIPPED, skip_reason="approval rejected"
            )
            await store.emit_event(
                run_id, name, "NodeSkipped", {"reason": "approval rejected"}
            )
            if on_rejection == "fail":
                raise

        except BaseException as exc:
            ctx.statuses[name] = "failed"
            ctx.errors[name] = exc
            await store.update_node_status(run_id, name, NodeStatus.FAILED, error=exc)
            await store.emit_event(
                run_id,
                name,
                "NodeFailed",
                {"error": str(exc), "error_type": type(exc).__name__},
            )
            if on_progress:
                await on_progress(
                    WorkflowEvent(type="failed", workflow_name=name, message=str(exc))
                )
            if fail_fast:
                raise

    async def run_node_with_semaphore(name: str) -> None:
        if semaphore is None:
            await run_node(name)
            return
        async with semaphore:
            await run_node(name)

    # Execute level by level
    try:
        for level in graph.levels:
            tasks = [
                asyncio.create_task(run_node_with_semaphore(name)) for name in level
            ]
            if not tasks:
                continue

            if fail_fast:
                try:
                    await asyncio.gather(*tasks)
                except ApprovalRejected:
                    raise
                except WorkflowError:
                    raise
                except BaseException:
                    if ctx.errors:
                        break
                    raise
            else:
                await asyncio.gather(*tasks, return_exceptions=False)
    except BaseException:
        # Update run status to FAILED
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await store.emit_event(run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        raise

    # Check for errors
    if ctx.errors:
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await store.emit_event(run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        first_name = next(iter(ctx.errors.keys()))
        raise WorkflowError(
            first_name,
            ctx.errors[first_name],
            completed=[
                name
                for name, status in ctx.statuses.items()
                if status in {"success", "cached"}
            ],
            errors=ctx.errors,
        )

    # Mark run as successful
    await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)
    await store.emit_event(run_id, None, "RunFinished", {})

    total_duration = (time.perf_counter() - start_time) * 1000.0
    stats = ExecutionStats(
        total_duration_ms=total_duration,
        workflows_executed=sum(1 for result in ctx.results if not result.cached),
        workflows_cached=sum(1 for result in ctx.results if result.cached),
        tokens_used=0,
    )

    root_output = ctx.outputs.get(graph.root)
    if return_all:
        return ExecutionResult(
            output=root_output,
            outputs=ctx.outputs,
            results=ctx.results,
            stats=stats,
            approvals=ctx.approvals,
        )

    return root_output
