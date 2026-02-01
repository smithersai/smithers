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
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, TypeAdapter

from smithers._shared import (
    build_kwargs as _build_kwargs,
)
from smithers._shared import (
    compute_cache_key as _cache_key,
)
from smithers._shared import (
    dependency_namespace as _dependency_namespace,
)
from smithers._shared import (
    hash_inputs as _hash_inputs,
)
from smithers._shared import (
    normalize_invalidate as _normalize_invalidate,
)
from smithers._shared import (
    prompt_for_approval as _prompt_for_approval,
)
from smithers._shared import (
    resolve_workflow as _resolve_workflow,
)
from smithers._shared import (
    validate_output as _validate_output,
)
from smithers.cache import Cache, SqliteCache
from smithers.conditions import (
    ConditionNotMetError,
    evaluate_condition,
    get_condition_policy,
)
from smithers.errors import (
    ApprovalRejected,
    GraphTimeoutError,
    PendingApprovalsError,
    RalphLoopConfigError,
    RalphLoopInputError,
    RunNotFoundError,
    RunNotPausedError,
    WorkflowError,
    WorkflowTimeoutError,
)
from smithers.events import Event, get_event_bus
from smithers.hashing import hash_json
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
from smithers.workflow import SkipResult, Workflow

if TYPE_CHECKING:
    pass


def _is_ralph_loop(wf: Workflow) -> bool:
    """Check if a workflow is a Ralph loop.

    Checks for the presence of loop_config attribute which is unique to
    RalphLoopWorkflow. This avoids the overhead of late imports on every call.
    """
    return getattr(wf, "loop_config", None) is not None


async def _mark_node_skipped(
    name: str,
    ctx: ExecutionContext,
    store: SqliteStore,
    skip_reason: str,
    *,
    output: Any = None,
    duration_ms: float = 0.0,
    event_payload: dict[str, Any] | None = None,
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
    progress_message: str | None = None,
) -> None:
    """Mark a node as skipped with all necessary state updates.

    This helper consolidates the repetitive pattern of marking nodes as skipped:
    1. Update context outputs and statuses
    2. Append a WorkflowResult
    3. Update store node status
    4. Emit a NodeSkipped event
    5. Optionally call on_progress callback

    Args:
        name: The node name
        ctx: The execution context
        store: The SQLite store
        skip_reason: Reason for skipping (stored in DB and events)
        output: Output value to store (default None)
        duration_ms: Execution duration if any (default 0.0)
        event_payload: Additional event payload data (merged with reason)
        on_progress: Optional progress callback
        progress_message: Message for progress callback (defaults to skip_reason)
    """
    ctx.outputs[name] = output
    ctx.statuses[name] = "skipped"
    ctx.results.append(
        WorkflowResult(name=name, output=output, cached=False, duration_ms=duration_ms)
    )
    await store.update_node_status(ctx.run_id, name, NodeStatus.SKIPPED, skip_reason=skip_reason)

    payload = {"reason": skip_reason}
    if event_payload:
        payload.update(event_payload)
    await _emit_event(store, ctx.run_id, name, "NodeSkipped", payload)

    if on_progress:
        await on_progress(
            WorkflowEvent(
                type="skipped",
                workflow_name=name,
                duration_ms=duration_ms if duration_ms > 0 else None,
                message=progress_message or skip_reason,
            )
        )


async def _emit_event(
    store: SqliteStore,
    run_id: str,
    node_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """
    Emit an event to both SQLite store and the in-process EventBus.

    This ensures events are persisted for cross-process visibility and
    also immediately available to in-process subscribers.
    """
    # Persist to SQLite
    event_id = await store.emit_event(run_id, node_id, event_type, payload)

    # Deliver to in-process subscribers
    event = Event(
        type=event_type,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
        event_id=event_id,
    )
    bus = get_event_bus()
    await bus.emit(event)


async def _execute_with_retry(
    wf: Workflow,
    kwargs: dict[str, Any],
    *,
    run_id: str,
    node_id: str,
    store: SqliteStore,
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
    timeout_seconds: float | None = None,
) -> tuple[BaseModel, float, int]:
    """
    Execute a workflow function with retry and timeout logic.

    Returns:
        Tuple of (output, total_duration_ms, attempt_count)

    Raises:
        The last exception if all retries are exhausted.
        WorkflowTimeoutError if the workflow times out.
    """
    from smithers.errors import WorkflowTimeoutError

    policy = wf.retry_policy
    last_exception: BaseException | None = None
    total_duration_ms = 0.0
    attempt = 0
    execution_start = time.perf_counter()

    while attempt < policy.max_attempts:
        attempt += 1

        # Check if we've exceeded the timeout before starting a new attempt
        if timeout_seconds is not None:
            elapsed = time.perf_counter() - execution_start
            if elapsed >= timeout_seconds:
                raise WorkflowTimeoutError(
                    workflow_name=node_id,
                    timeout_seconds=timeout_seconds,
                    elapsed_seconds=elapsed,
                )

        # Emit retry event if this is not the first attempt
        if attempt > 1:
            delay = policy.get_delay(attempt - 1)
            await _emit_event(
                store,
                run_id,
                node_id,
                "NodeRetrying",
                {
                    "attempt": attempt,
                    "max_attempts": policy.max_attempts,
                    "delay_seconds": delay,
                    "last_error": str(last_exception) if last_exception else None,
                    "last_error_type": type(last_exception).__name__ if last_exception else None,
                },
            )
            if on_progress:
                await on_progress(
                    WorkflowEvent(
                        type="retrying",
                        workflow_name=node_id,
                        message=f"Retry {attempt}/{policy.max_attempts} after {delay:.1f}s",
                    )
                )
            # Wait before retry
            await asyncio.sleep(delay)

        try:
            start = time.perf_counter()

            # Calculate remaining timeout for this attempt
            remaining_timeout: float | None = None
            if timeout_seconds is not None:
                elapsed_total = time.perf_counter() - execution_start
                remaining_timeout = timeout_seconds - elapsed_total
                if remaining_timeout <= 0:
                    raise WorkflowTimeoutError(
                        workflow_name=node_id,
                        timeout_seconds=timeout_seconds,
                        elapsed_seconds=elapsed_total,
                    )

            # Set up RuntimeContext for LLM and tool call tracking
            rt_ctx = RuntimeContext(run_id=run_id, node_id=node_id, store=store)
            with runtime_context(rt_ctx):
                if remaining_timeout is not None:
                    try:
                        output = await asyncio.wait_for(
                            wf(**kwargs),
                            timeout=remaining_timeout,
                        )
                    except TimeoutError:
                        elapsed_total = time.perf_counter() - execution_start
                        raise WorkflowTimeoutError(
                            workflow_name=node_id,
                            timeout_seconds=timeout_seconds or 0.0,
                            elapsed_seconds=elapsed_total,
                        ) from None
                else:
                    output = await wf(**kwargs)

            duration_ms = (time.perf_counter() - start) * 1000.0
            total_duration_ms += duration_ms

            # Success - return the output
            return output, total_duration_ms, attempt

        except PauseExecution:
            # Never retry pause requests
            raise

        except ApprovalRejected:
            # Never retry approval rejections
            raise

        except WorkflowTimeoutError:
            # Never retry timeouts - they are terminal
            raise

        except BaseException as exc:
            duration_ms = (time.perf_counter() - start) * 1000.0
            total_duration_ms += duration_ms
            last_exception = exc

            # Check if we should retry
            if not policy.should_retry(exc, attempt):
                # Either exhausted retries or exception type not retryable
                if attempt < policy.max_attempts:
                    # Exception type not retryable
                    await _emit_event(
                        store,
                        run_id,
                        node_id,
                        "NodeRetrySkipped",
                        {
                            "attempt": attempt,
                            "error": str(exc),
                            "error_type": type(exc).__name__,
                            "reason": "exception_not_retryable",
                        },
                    )
                raise

    # Should not reach here, but for type safety
    if last_exception is not None:
        raise last_exception
    raise RuntimeError("Unexpected state: no result and no exception")


async def _execute_ralph_loop_node(
    wf: Workflow,
    kwargs: dict[str, Any],
    *,
    run_id: str,
    node_id: str,
    store: SqliteStore,
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
) -> tuple[BaseModel, float, int]:
    """
    Execute a Ralph loop workflow with full iteration tracking.

    Returns:
        Tuple of (output, total_duration_ms, iteration_count)
    """
    from smithers.ralph_loop import RalphLoopWorkflow

    if not isinstance(wf, RalphLoopWorkflow):
        raise TypeError("Workflow must be a RalphLoopWorkflow")

    config = wf.loop_config
    inner_workflow = wf.inner_workflow

    if inner_workflow is None:
        raise RalphLoopConfigError(
            loop_name=wf.name,
            config_issue="inner_workflow is not set. Ensure the loop was created with ralph_loop().",
        )

    # Get the initial input from kwargs
    # The loop should take a single input parameter
    input_params = list(wf.input_types.keys())
    if not input_params:
        raise RalphLoopConfigError(
            loop_name=wf.name,
            config_issue="loop has no input parameters. Ralph loops require at least one input parameter.",
        )

    # For the first iteration, use the input from kwargs
    # For subsequent iterations, use the output of the previous iteration
    first_param = input_params[0]
    current = kwargs.get(first_param)

    if current is None:
        raise RalphLoopInputError(
            loop_name=wf.name,
            param_name=first_param,
        )

    total_duration_ms = 0.0
    final_iteration = 0

    for iteration in range(config.max_iterations):
        final_iteration = iteration + 1

        # Emit LoopIterationStarted event
        input_hash = hash_json(current.model_dump() if hasattr(current, "model_dump") else current)
        await store.emit_loop_iteration_started(
            run_id=run_id,
            loop_node_id=node_id,
            iteration=iteration,
            input_hash=input_hash,
        )

        if on_progress:
            await on_progress(
                WorkflowEvent(
                    type="loop_iteration_started",
                    workflow_name=node_id,
                    message=f"Iteration {iteration + 1}/{config.max_iterations}",
                )
            )

        # Execute the inner workflow
        iter_start = time.perf_counter()
        iter_kwargs = {}
        for param_name in inner_workflow.input_types:
            if param_name in inner_workflow.bound_args:
                iter_kwargs[param_name] = inner_workflow.bound_args[param_name]
            else:
                iter_kwargs[param_name] = current

        # Set up RuntimeContext for LLM and tool call tracking
        rt_ctx = RuntimeContext(run_id=run_id, node_id=node_id, store=store)
        with runtime_context(rt_ctx):
            result = await inner_workflow(**iter_kwargs)

        iter_duration_ms = (time.perf_counter() - iter_start) * 1000.0
        total_duration_ms += iter_duration_ms

        # Emit LoopIterationFinished event
        output_hash = hash_json(result.model_dump() if hasattr(result, "model_dump") else result)
        condition_met = False
        if config.until_condition is not None:
            condition_met = config.until_condition(result)

        await store.emit_loop_iteration_finished(
            run_id=run_id,
            loop_node_id=node_id,
            iteration=iteration,
            output_hash=output_hash,
        )

        if on_progress:
            await on_progress(
                WorkflowEvent(
                    type="loop_iteration_finished",
                    workflow_name=node_id,
                    duration_ms=iter_duration_ms,
                    message=f"Iteration {iteration + 1} complete"
                    + (" (condition met)" if condition_met else ""),
                )
            )

        # Check termination condition
        if condition_met:
            return result, total_duration_ms, final_iteration

        # Prepare for next iteration
        current = result

    # Max iterations reached
    await _emit_event(
        store,
        run_id,
        node_id,
        "LoopMaxIterationsReached",
        {"max_iterations": config.max_iterations, "final_iteration": final_iteration},
    )

    return current, total_duration_ms, final_iteration


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


@dataclass
class NodeExecutionOptions:
    """Options for node execution to handle differences between run and resume."""

    invalidated: set[str] = field(default_factory=set)
    headless: bool = False
    fail_fast: bool = False
    get_effective_timeout: Callable[[Workflow, str], float | None] | None = None
    approval_handler: Callable[[str, str], Awaitable[bool]] | None = None
    auto_approve: bool | Iterable[str] = False
    on_rejection: str = "fail"
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None
    skip_completed: bool = False


class PauseExecution(Exception):
    """Raised to indicate the run should pause for an approval."""

    def __init__(self, node_id: str, message: str) -> None:
        self.node_id = node_id
        self.message = message
        super().__init__(f"Execution paused for approval of node '{node_id}'")


async def _execute_node(
    name: str,
    ctx: ExecutionContext,
    store: SqliteStore,
    options: NodeExecutionOptions,
) -> None:
    """
    Execute a single node in the graph.

    This is the shared implementation for both run_graph_with_store and resume_run.
    All behavior differences are controlled via NodeExecutionOptions.
    """
    # Skip if already completed (used by resume_run)
    if options.skip_completed and ctx.statuses.get(name) in {"success", "cached", "skipped"}:
        return

    graph = ctx.graph
    run_id = ctx.run_id
    cache = ctx.cache

    node = graph.nodes[name]
    wf = _resolve_workflow(graph, node)

    # Check dependencies
    for dep in node.dependencies:
        if ctx.statuses.get(dep) in {"failed", "skipped"}:
            await _mark_node_skipped(name, ctx, store, "dependency failed")
            return

    # Emit NodeReady event
    await store.update_node_status(run_id, name, NodeStatus.READY)
    await _emit_event(store, run_id, name, "NodeReady", {})

    if options.on_progress:
        await options.on_progress(WorkflowEvent(type="started", workflow_name=name))

    try:
        # Check condition (if any) before proceeding
        condition_policy = wf.condition_policy or get_condition_policy(wf.fn)
        if condition_policy is not None:
            deps_namespace = _dependency_namespace(wf, ctx.outputs)
            condition_met = evaluate_condition(condition_policy, deps_namespace)

            if not condition_met:
                skip_reason = condition_policy.skip_reason
                on_skip_action = condition_policy.on_skip

                if on_skip_action == "fail":
                    raise ConditionNotMetError(name, skip_reason)
                elif on_skip_action == "default":
                    default_val = condition_policy.default_value
                    await _mark_node_skipped(
                        name,
                        ctx,
                        store,
                        f"condition: {skip_reason}",
                        output=default_val,
                        event_payload={"default_returned": True},
                        on_progress=options.on_progress,
                        progress_message=f"Condition not met: {skip_reason}",
                    )
                    return
                else:
                    await _mark_node_skipped(
                        name,
                        ctx,
                        store,
                        f"condition: {skip_reason}",
                        on_progress=options.on_progress,
                        progress_message=f"Condition not met: {skip_reason}",
                    )
                    return

        # Check cache (with optional invalidation)
        cache_key = None
        input_hash_value = None
        is_invalidated = name in options.invalidated or "*" in options.invalidated
        if cache is not None and not is_invalidated:
            input_hash_value = _hash_inputs(wf, ctx.outputs)
            cache_key = _cache_key(wf, input_hash_value)
            cached_value_raw = await cache.get(cache_key)
            if cached_value_raw is not None:
                # Validate and reconstruct the Pydantic model from cached dict
                # (Cache now stores JSON dicts for security, not pickled objects)
                adapter = TypeAdapter(node.output_type)
                cached_value = adapter.validate_python(cached_value_raw)
                ctx.outputs[name] = cached_value
                ctx.statuses[name] = "cached"
                ctx.results.append(
                    WorkflowResult(name=name, output=cached_value, cached=True, duration_ms=0.0)
                )
                await store.update_node_status(run_id, name, NodeStatus.CACHED, cache_key=cache_key)
                cached_to_store = (
                    cached_value.model_dump()
                    if hasattr(cached_value, "model_dump")
                    else cached_value
                )
                await store.store_node_output(run_id, name, cached_to_store)
                await _emit_event(store, run_id, name, "NodeCached", {"cache_key": cache_key})
                if options.on_progress:
                    await options.on_progress(WorkflowEvent(type="cached", workflow_name=name))
                return

        # Handle approval
        approved = await _maybe_require_approval(
            wf,
            node,
            ctx.outputs,
            run_id=run_id,
            store=store,
            approval_handler=options.approval_handler,
            auto_approve=options.auto_approve,
            on_rejection=options.on_rejection,
            approvals=ctx.approvals,
            headless=options.headless,
        )
        if not approved:
            await _mark_node_skipped(
                name,
                ctx,
                store,
                "Approval rejected",
                on_progress=options.on_progress,
            )
            return

        # Execute the workflow with retry support
        await store.update_node_status(run_id, name, NodeStatus.RUNNING)

        kwargs = _build_kwargs(wf, ctx.outputs)

        # Check if this is a Ralph loop and execute accordingly
        if _is_ralph_loop(wf):
            from smithers.ralph_loop import RalphLoopWorkflow

            await _emit_event(
                store,
                run_id,
                name,
                "NodeStarted",
                {
                    "is_ralph_loop": True,
                    "max_iterations": wf.loop_config.max_iterations
                    if isinstance(wf, RalphLoopWorkflow)
                    else 0,
                },
            )

            # Execute Ralph loop with iteration tracking
            output, duration_ms, iterations = await _execute_ralph_loop_node(
                wf,
                kwargs,
                run_id=run_id,
                node_id=name,
                store=store,
                on_progress=options.on_progress,
            )
            attempts = iterations
        else:
            # Calculate effective timeout for this node (if timeout function provided)
            effective_timeout: float | None = None
            if options.get_effective_timeout is not None:
                effective_timeout = options.get_effective_timeout(wf, name)

            started_payload: dict[str, Any] = {"max_attempts": wf.retry_policy.max_attempts}
            if effective_timeout is not None:
                started_payload["timeout_seconds"] = effective_timeout

            await _emit_event(
                store,
                run_id,
                name,
                "NodeStarted",
                started_payload,
            )

            # Execute with retry wrapper
            output, duration_ms, attempts = await _execute_with_retry(
                wf,
                kwargs,
                run_id=run_id,
                node_id=name,
                store=store,
                on_progress=options.on_progress,
                timeout_seconds=effective_timeout,
            )

        if isinstance(output, SkipResult):
            await _mark_node_skipped(
                name,
                ctx,
                store,
                output.reason,
                duration_ms=duration_ms,
                on_progress=options.on_progress,
            )
            return

        validated = _validate_output(wf, output)
        ctx.outputs[name] = validated
        ctx.statuses[name] = "success"
        ctx.results.append(
            WorkflowResult(name=name, output=validated, cached=False, duration_ms=duration_ms)
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
                validated.model_dump() if validated is not None else None
            ),
        )
        # Store node output for potential resume
        output_to_store = validated.model_dump() if validated is not None else None
        await store.store_node_output(run_id, name, output_to_store)

        # Add loop info to NodeFinished event if this was a Ralph loop
        finish_payload: dict[str, Any] = {
            "duration_ms": duration_ms,
            "cached": False,
        }
        if _is_ralph_loop(wf):
            finish_payload["iterations"] = attempts
            finish_payload["is_ralph_loop"] = True
        else:
            finish_payload["attempts"] = attempts

        await _emit_event(
            store,
            run_id,
            name,
            "NodeFinished",
            finish_payload,
        )

        if options.on_progress:
            await options.on_progress(
                WorkflowEvent(type="completed", workflow_name=name, duration_ms=duration_ms)
            )

    except PauseExecution:
        # Re-raise PauseExecution to be handled at the outer level
        raise

    except ConditionNotMetError as exc:
        ctx.statuses[name] = "failed"
        ctx.errors[name] = exc
        await store.update_node_status(run_id, name, NodeStatus.FAILED, error=exc)
        await _emit_event(store, run_id, name, "NodeConditionFailed", {"reason": exc.reason})
        if options.on_progress:
            await options.on_progress(
                WorkflowEvent(type="failed", workflow_name=name, message=str(exc))
            )
        if options.fail_fast:
            raise

    except ApprovalRejected as exc:
        ctx.errors[name] = exc
        await _mark_node_skipped(name, ctx, store, "approval rejected")
        if options.on_rejection == "fail":
            raise

    except WorkflowTimeoutError as exc:
        ctx.statuses[name] = "failed"
        ctx.errors[name] = exc
        await store.update_node_status(run_id, name, NodeStatus.FAILED, error=exc)
        await _emit_event(
            store,
            run_id,
            name,
            "NodeTimedOut",
            {
                "timeout_seconds": exc.timeout_seconds,
                "elapsed_seconds": exc.elapsed_seconds,
            },
        )
        if options.on_progress:
            await options.on_progress(
                WorkflowEvent(type="timeout", workflow_name=name, message=str(exc))
            )
        if options.fail_fast:
            raise

    except GraphTimeoutError:
        # Re-raise graph timeout to be handled at the outer level
        raise

    except BaseException as exc:
        ctx.statuses[name] = "failed"
        ctx.errors[name] = exc
        error_to_store = exc if isinstance(exc, Exception) else Exception(str(exc))
        await store.update_node_status(run_id, name, NodeStatus.FAILED, error=error_to_store)
        await _emit_event(
            store,
            run_id,
            name,
            "NodeFailed",
            {"error": str(exc), "error_type": type(exc).__name__},
        )
        if options.on_progress:
            await options.on_progress(
                WorkflowEvent(type="failed", workflow_name=name, message=str(exc))
            )
        if options.fail_fast:
            raise


async def run_graph_with_store(
    graph: WorkflowGraph,
    *,
    store: SqliteStore | None = None,
    cache: Cache | None = None,
    max_concurrency: int | None = None,
    fail_fast: bool = False,
    return_all: bool = False,
    dry_run: bool = False,
    invalidate: Iterable[str | Workflow] | str | Workflow | None = None,
    approval_handler: Callable[[str, str], Awaitable[bool]] | None = None,
    auto_approve: bool | Iterable[str] = False,
    on_rejection: str = "fail",
    on_progress: Callable[[WorkflowEvent], Awaitable[None]] | None = None,
    run_id: str | None = None,
    headless: bool = False,
    timeout: float | None = None,
    node_timeout: float | None = None,
) -> BaseModel | None | ExecutionResult | DryRunPlan:
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
        invalidate: Workflow names or Workflow objects to force re-execution
        approval_handler: Custom approval handler
        auto_approve: Auto-approve workflows
        on_rejection: Behavior on rejection ("fail" or "skip")
        on_progress: Progress callback
        run_id: Custom run ID (generated if None)
        headless: If True, pause execution when approval is required instead of prompting
        timeout: Global timeout for entire graph execution in seconds
        node_timeout: Default timeout for individual nodes in seconds (overridden by @timeout)

    Returns:
        The output of the root workflow (or ExecutionResult if return_all=True)

    Raises:
        PauseExecution: If headless=True and an approval is required
        GraphTimeoutError: If the global timeout is exceeded
        WorkflowTimeoutError: If a node timeout is exceeded
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
    await _emit_event(store, run_id, None, "RunStarted", {"target": graph.root})

    invalidated = _normalize_invalidate(invalidate)

    ctx = ExecutionContext(
        graph=graph,
        run_id=run_id,
        store=store,
        cache=cache,
    )

    semaphore = asyncio.Semaphore(max_concurrency) if max_concurrency else None
    start_time = time.perf_counter()

    def _get_effective_timeout(wf: Workflow, name: str) -> float | None:
        """Calculate the effective timeout for a node."""
        # Priority: workflow-specific timeout > default node_timeout > global timeout remaining
        wf_timeout: float | None = None
        if wf.timeout_policy is not None:
            wf_timeout = wf.timeout_policy.timeout_seconds

        effective = wf_timeout or node_timeout

        # If there's a global timeout, we need to constrain by remaining time
        if timeout is not None:
            elapsed = time.perf_counter() - start_time
            remaining = timeout - elapsed
            if remaining <= 0:
                raise GraphTimeoutError(
                    timeout_seconds=timeout,
                    elapsed_seconds=elapsed,
                    completed_nodes=[
                        n for n, s in ctx.statuses.items() if s in ("success", "cached")
                    ],
                    running_nodes=[
                        n
                        for n, s in ctx.statuses.items()
                        if s not in ("success", "cached", "skipped", "failed")
                    ],
                )
            if effective is not None:
                return min(effective, remaining)
            return remaining

        return effective

    # Create node execution options for this run
    node_options = NodeExecutionOptions(
        invalidated=invalidated,
        headless=headless,
        fail_fast=fail_fast,
        get_effective_timeout=_get_effective_timeout,
        approval_handler=approval_handler,
        auto_approve=auto_approve,
        on_rejection=on_rejection,
        on_progress=on_progress,
        skip_completed=False,
    )

    async def run_node_in_main(name: str) -> None:
        """Node executor for run_graph_with_store."""
        await _execute_node(name, ctx, store, node_options)

    async def run_node_with_semaphore_main(name: str) -> None:
        if semaphore is None:
            await run_node_in_main(name)
            return
        async with semaphore:
            await run_node_in_main(name)

    # Execute level by level for run_graph_with_store
    try:
        for level in graph.levels:
            tasks = [asyncio.create_task(run_node_with_semaphore_main(name)) for name in level]
            if not tasks:
                continue

            # Check global timeout before each level
            if timeout is not None:
                elapsed = time.perf_counter() - start_time
                if elapsed >= timeout:
                    raise GraphTimeoutError(
                        timeout_seconds=timeout,
                        elapsed_seconds=elapsed,
                        completed_nodes=[
                            n for n, s in ctx.statuses.items() if s in ("success", "cached")
                        ],
                        running_nodes=[],
                    )

            if fail_fast:
                try:
                    await asyncio.gather(*tasks)
                except ApprovalRejected:
                    raise
                except WorkflowError:
                    raise
                except PauseExecution:
                    raise
                except GraphTimeoutError:
                    raise
                except WorkflowTimeoutError:
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
        await _emit_event(
            store,
            run_id,
            exc.node_id,
            "RunPaused",
            {"node_id": exc.node_id, "message": exc.message},
        )
        raise
    except GraphTimeoutError as exc:
        # Update run status to FAILED due to timeout
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await _emit_event(
            store,
            run_id,
            None,
            "RunTimedOut",
            {
                "timeout_seconds": exc.timeout_seconds,
                "elapsed_seconds": exc.elapsed_seconds,
                "completed_nodes": exc.completed_nodes,
                "running_nodes": exc.running_nodes,
            },
        )
        raise
    except BaseException:
        # Update run status to FAILED
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await _emit_event(store, run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        raise

    # Check for errors
    if ctx.errors:
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await _emit_event(store, run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        first_name = next(iter(ctx.errors.keys()))
        raise WorkflowError(
            first_name,
            ctx.errors[first_name],
            completed=[
                name for name, status in ctx.statuses.items() if status in {"success", "cached"}
            ],
            errors=ctx.errors,
        )

    # Mark run as successful
    await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)
    await _emit_event(store, run_id, None, "RunFinished", {})

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
        await _emit_event(store, run_id, wf.name, "ApprovalRequested", {"prompt": message})

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
    await _emit_event(store, run_id, wf.name, "ApprovalDecided", {"approved": approved})

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


# Note: _prompt_for_approval is imported from _shared module as _prompt_for_approval


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
) -> BaseModel | None | ExecutionResult:
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
        RunNotFoundError: If run does not exist
        RunNotPausedError: If run is not in paused state
        PendingApprovalsError: If run has pending approvals that need to be decided
    """
    from smithers.config import get_config

    await store.initialize()

    # Get the run
    run = await store.get_run(run_id)
    if run is None:
        raise RunNotFoundError(run_id)

    if run.status != RunStatus.PAUSED:
        raise RunNotPausedError(run_id, run.status.value)

    # Check for pending approvals
    pending_approvals = await store.get_pending_approvals(run_id)
    if pending_approvals:
        node_ids = [a.node_id for a in pending_approvals]
        raise PendingApprovalsError(run_id, node_ids)

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
                ctx.statuses[node.node_id] = (
                    "success" if node.status == NodeStatus.SUCCESS else "cached"
                )
        elif node.status == NodeStatus.SKIPPED:
            ctx.outputs[node.node_id] = None
            ctx.statuses[node.node_id] = "skipped"
        elif node.status == NodeStatus.FAILED:
            ctx.statuses[node.node_id] = "failed"

    # Update run status to RUNNING
    await store.update_run_status(run_id, RunStatus.RUNNING)
    await _emit_event(
        store, run_id, None, "RunResumed", {"restored_nodes": list(stored_outputs.keys())}
    )

    semaphore = asyncio.Semaphore(max_concurrency) if max_concurrency else None
    start_time = time.perf_counter()

    # Create node execution options for resume (no invalidation, no headless, skip completed)
    resume_options = NodeExecutionOptions(
        invalidated=set(),  # No invalidation for resume
        headless=False,  # Not headless for resume
        fail_fast=fail_fast,
        get_effective_timeout=None,  # No timeout for resume
        approval_handler=approval_handler,
        auto_approve=auto_approve,
        on_rejection=on_rejection,
        on_progress=on_progress,
        skip_completed=True,  # Skip already completed nodes
    )

    async def run_node(name: str) -> None:
        """Node executor for resume_run."""
        await _execute_node(name, ctx, store, resume_options)

    async def run_node_with_semaphore(name: str) -> None:
        if semaphore is None:
            await run_node(name)
            return
        async with semaphore:
            await run_node(name)

    # Execute level by level
    try:
        for level in graph.levels:
            tasks = [asyncio.create_task(run_node_with_semaphore(name)) for name in level]
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
        await _emit_event(store, run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        raise

    # Check for errors
    if ctx.errors:
        await store.update_run_status(run_id, RunStatus.FAILED, finished=True)
        await _emit_event(store, run_id, None, "RunFailed", {"errors": list(ctx.errors.keys())})
        first_name = next(iter(ctx.errors.keys()))
        raise WorkflowError(
            first_name,
            ctx.errors[first_name],
            completed=[
                name for name, status in ctx.statuses.items() if status in {"success", "cached"}
            ],
            errors=ctx.errors,
        )

    # Mark run as successful
    await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)
    await _emit_event(store, run_id, None, "RunFinished", {})

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
