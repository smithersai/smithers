"""Runtime context for dependency injection via contextvars.

This module provides RuntimeContext, which enables:
1. Automatic tracking of LLM calls during workflow execution
2. Automatic tracking of tool calls during workflow execution
3. Access to the current run_id and node_id within workflows
4. Access to the store for recording events and metrics

The RuntimeContext is automatically set by the ExecutionEngine when running
workflows, making it transparent to workflow code while enabling full
observability.

Example usage within a workflow:
    from smithers.runtime import get_current_context

    @workflow
    async def my_workflow() -> Output:
        ctx = get_current_context()
        if ctx:
            print(f"Running in run {ctx.run_id}, node {ctx.node_id}")
        return await claude("Do something", output=Output)
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from smithers.store.sqlite import SqliteStore


@dataclass
class RuntimeContext:
    """
    Context for the current workflow execution.

    This is set automatically by the ExecutionEngine during graph execution
    and provides access to:
    - run_id: The ID of the current execution run
    - node_id: The ID of the current workflow node being executed
    - store: The SqliteStore for recording events and metrics

    The context is available to claude() and tool invocations automatically,
    enabling transparent tracking of all LLM and tool calls.
    """

    run_id: str
    node_id: str
    store: SqliteStore | None = None


# Context variable for the current runtime context
_current_context: ContextVar[RuntimeContext | None] = ContextVar(
    "smithers_runtime_context", default=None
)


def get_current_context() -> RuntimeContext | None:
    """
    Get the current runtime context, if any.

    Returns None if not executing within a workflow graph.

    Example:
        ctx = get_current_context()
        if ctx:
            print(f"Executing node {ctx.node_id} in run {ctx.run_id}")
    """
    return _current_context.get()


def set_current_context(ctx: RuntimeContext | None) -> Token[RuntimeContext | None]:
    """
    Set the current runtime context.

    Returns a token that can be used to reset the context later.
    This is primarily used by the ExecutionEngine.

    Example:
        token = set_current_context(RuntimeContext(run_id="abc", node_id="step1"))
        try:
            await execute_workflow()
        finally:
            reset_context(token)
    """
    return _current_context.set(ctx)


def reset_context(token: Token[RuntimeContext | None]) -> None:
    """
    Reset the context to its previous value using a token.

    This should be called with the token returned by set_current_context()
    to properly restore the previous context state.
    """
    _current_context.reset(token)


class runtime_context:
    """
    Context manager for setting the runtime context.

    Usage:
        with runtime_context(RuntimeContext(run_id="abc", node_id="step1", store=store)):
            await execute_workflow()
    """

    def __init__(self, ctx: RuntimeContext) -> None:
        self.ctx = ctx
        self.token: Token[RuntimeContext | None] | None = None

    def __enter__(self) -> RuntimeContext:
        self.token = set_current_context(self.ctx)
        return self.ctx

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self.token is not None:
            reset_context(self.token)


async def record_llm_call_start(
    model: str,
    request: dict[str, Any] | None = None,
) -> int | None:
    """
    Record the start of an LLM call if a runtime context is active.

    Returns the call_id for later completion, or None if no context.
    """
    ctx = get_current_context()
    if ctx is None or ctx.store is None:
        return None

    return await ctx.store.record_llm_call_start(
        run_id=ctx.run_id,
        node_id=ctx.node_id,
        model=model,
        request=request,
    )


async def record_llm_call_end(
    call_id: int | None,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
    response: dict[str, Any] | None = None,
) -> None:
    """
    Record the completion of an LLM call.

    Does nothing if call_id is None (no context was active at start).
    """
    if call_id is None:
        return

    ctx = get_current_context()
    if ctx is None or ctx.store is None:
        return

    await ctx.store.record_llm_call_end(
        call_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
        response=response,
    )


async def record_tool_call_start(
    tool_name: str,
    input_data: dict[str, Any],
) -> int | None:
    """
    Record the start of a tool call if a runtime context is active.

    Returns the tool_call_id for later completion, or None if no context.
    """
    ctx = get_current_context()
    if ctx is None or ctx.store is None:
        return None

    return await ctx.store.record_tool_call_start(
        run_id=ctx.run_id,
        node_id=ctx.node_id,
        tool_name=tool_name,
        input_data=input_data,
    )


async def record_tool_call_end(
    tool_call_id: int | None,
    *,
    output: dict[str, Any] | None = None,
    error: Exception | None = None,
) -> None:
    """
    Record the completion of a tool call.

    Does nothing if tool_call_id is None (no context was active at start).
    """
    if tool_call_id is None:
        return

    ctx = get_current_context()
    if ctx is None or ctx.store is None:
        return

    await ctx.store.record_tool_call_end(
        tool_call_id,
        output=output,
        error=error,
    )
