"""Timeout handling for Smithers workflows.

This module provides timeout configuration and enforcement for workflows and
graph execution. Timeouts prevent runaway workflows from blocking execution
indefinitely and enable more predictable resource usage.

Features:
- Per-workflow timeout via @timeout decorator
- Global graph execution timeout via run_graph
- Configurable timeout policies with escalation
- Timeout events for observability
- Graceful cancellation with cleanup time

Example:
    from smithers import workflow, timeout
    from datetime import timedelta

    @workflow
    @timeout(seconds=30)
    async def quick_task() -> Output:
        ...

    @workflow
    @timeout(timedelta(minutes=5), on_timeout="skip")
    async def optional_task() -> Output:
        ...
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import timedelta
from enum import Enum
from functools import wraps
from typing import Any, ParamSpec, TypeVar

from pydantic import BaseModel

P = ParamSpec("P")
T = TypeVar("T", bound=BaseModel)


class TimeoutAction(str, Enum):
    """Action to take when a workflow times out."""

    FAIL = "fail"  # Raise WorkflowTimeoutError (default)
    SKIP = "skip"  # Skip the workflow (mark as skipped)
    CANCEL = "cancel"  # Cancel and mark as cancelled


@dataclass(frozen=True)
class TimeoutPolicy:
    """
    Configuration for workflow timeout behavior.

    Attributes:
        timeout_seconds: Maximum time allowed for workflow execution in seconds.
                        Must be > 0.
        on_timeout: Action to take when timeout occurs. Default is FAIL.
        grace_period_seconds: Additional time allowed after timeout signal for
                             cleanup. Default is 5.0 seconds.
        include_queue_time: Whether to include time spent waiting in queue
                           (for concurrency-limited execution). Default is False.

    Example:
        # Basic timeout
        policy = TimeoutPolicy(timeout_seconds=30.0)

        # Skip on timeout instead of failing
        policy = TimeoutPolicy(timeout_seconds=60.0, on_timeout=TimeoutAction.SKIP)

        # Include queue time in timeout calculation
        policy = TimeoutPolicy(timeout_seconds=120.0, include_queue_time=True)
    """

    timeout_seconds: float
    on_timeout: TimeoutAction = TimeoutAction.FAIL
    grace_period_seconds: float = 5.0
    include_queue_time: bool = False

    def __post_init__(self) -> None:
        """Validate timeout policy parameters."""
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if self.grace_period_seconds < 0:
            raise ValueError("grace_period_seconds must be >= 0")

    @classmethod
    def from_timedelta(
        cls,
        timeout: timedelta,
        *,
        on_timeout: TimeoutAction = TimeoutAction.FAIL,
        grace_period: timedelta | None = None,
        include_queue_time: bool = False,
    ) -> TimeoutPolicy:
        """Create a TimeoutPolicy from timedelta objects."""
        return cls(
            timeout_seconds=timeout.total_seconds(),
            on_timeout=on_timeout,
            grace_period_seconds=grace_period.total_seconds() if grace_period else 5.0,
            include_queue_time=include_queue_time,
        )

    def remaining(self, elapsed_seconds: float) -> float:
        """Calculate remaining time before timeout."""
        return max(0.0, self.timeout_seconds - elapsed_seconds)

    def is_expired(self, elapsed_seconds: float) -> bool:
        """Check if timeout has expired."""
        return elapsed_seconds >= self.timeout_seconds


# Default timeout policies
NO_TIMEOUT: TimeoutPolicy | None = None
SHORT_TIMEOUT = TimeoutPolicy(timeout_seconds=30.0)
MEDIUM_TIMEOUT = TimeoutPolicy(timeout_seconds=120.0)
LONG_TIMEOUT = TimeoutPolicy(timeout_seconds=600.0)


# Import error types from smithers.errors for consistency
from smithers.errors import GraphTimeoutError, WorkflowTimeoutError


def timeout(
    timeout_value: float | timedelta | TimeoutPolicy | None = None,
    *,
    seconds: float | None = None,
    minutes: float | None = None,
    on_timeout: str | TimeoutAction = TimeoutAction.FAIL,
    grace_period_seconds: float = 5.0,
    include_queue_time: bool = False,
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to configure timeout behavior for a workflow.

    This decorator should be applied before @workflow to configure timeouts.
    It supports multiple ways to specify the timeout duration.

    Args:
        timeout_value: A float (seconds), timedelta, or TimeoutPolicy.
                      If provided, other duration parameters are ignored.
        seconds: Timeout in seconds (convenience parameter).
        minutes: Timeout in minutes (convenience parameter).
        on_timeout: Action when timeout occurs ("fail", "skip", or "cancel").
        grace_period_seconds: Time for cleanup after timeout signal.
        include_queue_time: Whether queue wait time counts toward timeout.

    Example:
        @workflow
        @timeout(30)  # 30 seconds
        async def quick_task() -> Output:
            ...

        @workflow
        @timeout(seconds=60)
        async def medium_task() -> Output:
            ...

        @workflow
        @timeout(minutes=5, on_timeout="skip")
        async def optional_task() -> Output:
            ...

        @workflow
        @timeout(timedelta(hours=1))
        async def long_task() -> Output:
            ...
    """
    # Determine the timeout policy
    policy: TimeoutPolicy | None = None

    if isinstance(timeout_value, TimeoutPolicy):
        policy = timeout_value
    elif isinstance(timeout_value, timedelta):
        action = TimeoutAction(on_timeout) if isinstance(on_timeout, str) else on_timeout
        policy = TimeoutPolicy.from_timedelta(
            timeout_value,
            on_timeout=action,
            grace_period=timedelta(seconds=grace_period_seconds),
            include_queue_time=include_queue_time,
        )
    elif isinstance(timeout_value, (int, float)):
        action = TimeoutAction(on_timeout) if isinstance(on_timeout, str) else on_timeout
        policy = TimeoutPolicy(
            timeout_seconds=float(timeout_value),
            on_timeout=action,
            grace_period_seconds=grace_period_seconds,
            include_queue_time=include_queue_time,
        )
    elif seconds is not None or minutes is not None:
        total_seconds = (seconds or 0.0) + (minutes or 0.0) * 60.0
        if total_seconds <= 0:
            raise ValueError("Timeout must be positive")
        action = TimeoutAction(on_timeout) if isinstance(on_timeout, str) else on_timeout
        policy = TimeoutPolicy(
            timeout_seconds=total_seconds,
            on_timeout=action,
            grace_period_seconds=grace_period_seconds,
            include_queue_time=include_queue_time,
        )
    else:
        raise ValueError(
            "Must provide timeout_value, seconds, or minutes parameter"
        )

    def decorator(fn: Callable[P, Coroutine[Any, Any, T]]) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            # The actual timeout enforcement is handled by the executor
            # This wrapper just passes through for direct calls
            return await fn(*args, **kwargs)

        # Store the timeout policy on the function for the @workflow decorator to pick up
        wrapper._timeout_policy = policy  # type: ignore[attr-defined]
        return wrapper

    return decorator


async def execute_with_timeout(
    coro: Coroutine[Any, Any, T],
    policy: TimeoutPolicy,
    *,
    workflow_name: str = "unknown",
    on_timeout_callback: Callable[[WorkflowTimeoutError], Coroutine[Any, Any, None]] | None = None,
) -> T:
    """
    Execute a coroutine with timeout enforcement.

    This is a helper function that can be used to wrap coroutine execution
    with timeout handling, including grace period and custom callbacks.

    Args:
        coro: The coroutine to execute
        policy: The timeout policy to enforce
        workflow_name: Name for error reporting
        on_timeout_callback: Optional async callback when timeout occurs

    Returns:
        The result of the coroutine

    Raises:
        WorkflowTimeoutError: If timeout occurs and policy.on_timeout is FAIL
        asyncio.CancelledError: If the coroutine is cancelled
    """
    import time

    start_time = time.perf_counter()

    try:
        result = await asyncio.wait_for(coro, timeout=policy.timeout_seconds)
        return result
    except asyncio.TimeoutError:
        elapsed = time.perf_counter() - start_time
        error = WorkflowTimeoutError(
            workflow_name=workflow_name,
            timeout_seconds=policy.timeout_seconds,
            elapsed_seconds=elapsed,
        )

        if on_timeout_callback is not None:
            try:
                await asyncio.wait_for(
                    on_timeout_callback(error),
                    timeout=policy.grace_period_seconds,
                )
            except asyncio.TimeoutError:
                pass  # Grace period also expired

        if policy.on_timeout == TimeoutAction.FAIL:
            raise error from None
        elif policy.on_timeout == TimeoutAction.CANCEL:
            raise asyncio.CancelledError(f"Workflow '{workflow_name}' cancelled due to timeout")
        else:
            # SKIP - the caller should handle this case
            raise error from None


@dataclass
class TimeoutState:
    """
    Tracks timeout state during graph execution.

    This is used internally by the executor to track global and per-node
    timeout states during graph execution.
    """

    global_timeout_seconds: float | None = None
    start_time: float = field(default_factory=lambda: __import__("time").perf_counter())
    node_timeouts: dict[str, TimeoutPolicy] = field(default_factory=dict)
    node_start_times: dict[str, float] = field(default_factory=dict)
    timed_out_nodes: list[str] = field(default_factory=list)

    def global_remaining(self) -> float | None:
        """Get remaining global timeout, or None if no global timeout."""
        if self.global_timeout_seconds is None:
            return None
        import time

        elapsed = time.perf_counter() - self.start_time
        return max(0.0, self.global_timeout_seconds - elapsed)

    def is_globally_expired(self) -> bool:
        """Check if global timeout has expired."""
        if self.global_timeout_seconds is None:
            return False
        import time

        elapsed = time.perf_counter() - self.start_time
        return elapsed >= self.global_timeout_seconds

    def start_node(self, node_id: str, policy: TimeoutPolicy | None = None) -> None:
        """Record that a node has started execution."""
        import time

        self.node_start_times[node_id] = time.perf_counter()
        if policy is not None:
            self.node_timeouts[node_id] = policy

    def node_remaining(self, node_id: str) -> float | None:
        """Get remaining time for a node, considering both node and global timeouts."""
        import time

        # No timeout tracking for this node
        if node_id not in self.node_start_times:
            return self.global_remaining()

        start_time = self.node_start_times[node_id]
        elapsed = time.perf_counter() - start_time

        # Check node-specific timeout
        node_remaining: float | None = None
        if node_id in self.node_timeouts:
            policy = self.node_timeouts[node_id]
            node_remaining = policy.remaining(elapsed)

        # Get global remaining
        global_remaining = self.global_remaining()

        # Return the minimum of node and global remaining times
        if node_remaining is not None and global_remaining is not None:
            return min(node_remaining, global_remaining)
        return node_remaining or global_remaining

    def record_timeout(self, node_id: str) -> None:
        """Record that a node timed out."""
        if node_id not in self.timed_out_nodes:
            self.timed_out_nodes.append(node_id)


def get_effective_timeout(
    node_timeout: TimeoutPolicy | None,
    global_remaining: float | None,
) -> float | None:
    """
    Calculate the effective timeout for a node, considering both node and global limits.

    Args:
        node_timeout: The node's configured timeout policy (if any)
        global_remaining: Remaining time from global timeout (if any)

    Returns:
        The effective timeout in seconds, or None if no timeout applies
    """
    node_seconds: float | None = None
    if node_timeout is not None:
        node_seconds = node_timeout.timeout_seconds

    if node_seconds is not None and global_remaining is not None:
        return min(node_seconds, global_remaining)
    return node_seconds or global_remaining
