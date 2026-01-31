"""Event Bus for in-process fanout.

This module provides the EventBus class, which enables programmatic event
subscription for real-time progress monitoring without polling SQLite.

The EventBus complements the SQLite event log by providing in-process
fanout to registered listeners. Events are still persisted to SQLite for
durability and cross-process visibility, but subscribers can react to
events immediately without polling.

Example usage:
    from smithers.events import EventBus, Event, get_event_bus

    # Get the global event bus
    bus = get_event_bus()

    # Subscribe to events
    def on_node_started(event: Event) -> None:
        print(f"Node {event.node_id} started")

    bus.subscribe("NodeStarted", on_node_started)

    # Or subscribe to all events
    bus.subscribe_all(lambda e: print(f"Event: {e.type}"))

    # Use async handlers
    async def async_handler(event: Event) -> None:
        await some_async_operation(event)

    bus.subscribe("NodeFinished", async_handler)
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

# Type aliases for event handlers
type SyncEventHandler = Callable[["Event"], None]
type AsyncEventHandler = Callable[["Event"], Awaitable[None]]
type EventHandler = SyncEventHandler | AsyncEventHandler


@dataclass
class Event:
    """An event emitted during workflow execution.

    Events are immutable records of significant occurrences during execution.
    They are persisted to SQLite for durability and can be subscribed to
    via the EventBus for real-time processing.

    Attributes:
        type: The event type (e.g., "NodeStarted", "RunCreated")
        run_id: The run ID this event belongs to
        node_id: The node ID (None for run-level events)
        ts: Timestamp of the event (UTC)
        payload: Additional event-specific data
        event_id: Optional SQLite event_id if persisted
    """

    type: str
    run_id: str
    node_id: str | None = None
    ts: datetime = field(default_factory=lambda: datetime.now(UTC))
    payload: dict[str, Any] = field(default_factory=lambda: {})
    event_id: int | None = None

    def with_payload(self, **kwargs: Any) -> Event:
        """Create a new event with additional payload fields."""
        new_payload = {**self.payload, **kwargs}
        return Event(
            type=self.type,
            run_id=self.run_id,
            node_id=self.node_id,
            ts=self.ts,
            payload=new_payload,
            event_id=self.event_id,
        )


@dataclass
class Subscription:
    """A subscription to events on the event bus.

    Use the unsubscribe() method or pass to EventBus.unsubscribe() to stop
    receiving events.
    """

    id: str
    event_type: str | None  # None means all events
    handler: EventHandler
    bus: EventBus

    def unsubscribe(self) -> None:
        """Unsubscribe this handler from the event bus."""
        self.bus.unsubscribe(self)


class EventBus:
    """In-process event bus for fanout to subscribers.

    The EventBus enables programmatic event subscription for real-time
    progress monitoring. It complements the SQLite event log by providing
    immediate notification to in-process listeners.

    Features:
    - Subscribe to specific event types or all events
    - Support for both sync and async handlers
    - Thread-safe subscription management
    - Automatic handler execution (sync in thread, async awaited)

    Example:
        bus = EventBus()

        # Subscribe to specific event type
        sub = bus.subscribe("NodeStarted", lambda e: print(e))

        # Subscribe to all events
        bus.subscribe_all(lambda e: log_event(e))

        # Emit an event
        await bus.emit(Event(type="NodeStarted", run_id="run-123", node_id="analyze"))

        # Unsubscribe
        sub.unsubscribe()
    """

    def __init__(self) -> None:
        """Initialize the event bus."""
        self._handlers: dict[str, list[Subscription]] = {}  # type -> subscriptions
        self._all_handlers: list[Subscription] = []  # subscribers to all events
        self._lock = asyncio.Lock()
        self._paused = False
        self._queue: list[Event] = []  # events queued while paused

    def subscribe(
        self,
        event_type: str,
        handler: EventHandler,
    ) -> Subscription:
        """Subscribe to events of a specific type.

        Args:
            event_type: The event type to subscribe to (e.g., "NodeStarted")
            handler: Callback function (sync or async) to handle events

        Returns:
            A Subscription object that can be used to unsubscribe
        """
        sub = Subscription(
            id=str(uuid4()),
            event_type=event_type,
            handler=handler,
            bus=self,
        )
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(sub)
        return sub

    def subscribe_all(self, handler: EventHandler) -> Subscription:
        """Subscribe to all events.

        Args:
            handler: Callback function (sync or async) to handle events

        Returns:
            A Subscription object that can be used to unsubscribe
        """
        sub = Subscription(
            id=str(uuid4()),
            event_type=None,
            handler=handler,
            bus=self,
        )
        self._all_handlers.append(sub)
        return sub

    def unsubscribe(self, subscription: Subscription) -> bool:
        """Unsubscribe a handler from the event bus.

        Args:
            subscription: The subscription to remove

        Returns:
            True if the subscription was found and removed
        """
        if subscription.event_type is None:
            # All-events subscription
            if subscription in self._all_handlers:
                self._all_handlers.remove(subscription)
                return True
        else:
            # Type-specific subscription
            handlers = self._handlers.get(subscription.event_type, [])
            if subscription in handlers:
                handlers.remove(subscription)
                return True
        return False

    def unsubscribe_all(self) -> int:
        """Remove all subscriptions.

        Returns:
            The number of subscriptions removed
        """
        count = len(self._all_handlers)
        for handlers in self._handlers.values():
            count += len(handlers)
        self._handlers.clear()
        self._all_handlers.clear()
        return count

    async def emit(self, event: Event) -> None:
        """Emit an event to all relevant subscribers.

        If the bus is paused, events are queued and will be delivered
        when the bus is resumed.

        Args:
            event: The event to emit
        """
        if self._paused:
            self._queue.append(event)
            return

        await self._deliver(event)

    async def _deliver(self, event: Event) -> None:
        """Deliver an event to all relevant handlers."""
        # Collect all relevant handlers
        handlers: list[EventHandler] = []

        # Add type-specific handlers
        if event.type in self._handlers:
            handlers.extend(sub.handler for sub in self._handlers[event.type])

        # Add all-events handlers
        handlers.extend(sub.handler for sub in self._all_handlers)

        # Execute all handlers
        for handler in handlers:
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                # Log but don't propagate handler errors
                pass

    def emit_sync(self, event: Event) -> None:
        """Emit an event synchronously (schedules async delivery).

        This is useful when emitting from sync code. The event will be
        delivered asynchronously to handlers.

        Args:
            event: The event to emit
        """
        if self._paused:
            self._queue.append(event)
            return

        try:
            loop = asyncio.get_running_loop()
            # Store reference to prevent garbage collection
            task = loop.create_task(self._deliver(event))
            # Allow the task to be garbage collected after completion
            task.add_done_callback(lambda _: None)
        except RuntimeError:
            # No running loop - queue for later
            self._queue.append(event)

    def pause(self) -> None:
        """Pause event delivery.

        Events emitted while paused are queued and will be delivered
        when resume() is called.
        """
        self._paused = True

    async def resume(self) -> int:
        """Resume event delivery and deliver queued events.

        Returns:
            The number of queued events that were delivered
        """
        self._paused = False
        queued = list(self._queue)
        self._queue.clear()
        for event in queued:
            await self._deliver(event)
        return len(queued)

    def is_paused(self) -> bool:
        """Check if the event bus is paused."""
        return self._paused

    def queued_count(self) -> int:
        """Get the number of events currently queued."""
        return len(self._queue)

    def subscriber_count(self, event_type: str | None = None) -> int:
        """Get the number of subscribers.

        Args:
            event_type: If provided, count only subscribers for this type.
                       If None, count all subscribers including all-events subscribers.

        Returns:
            The number of subscribers
        """
        if event_type is not None:
            return len(self._handlers.get(event_type, []))
        count = len(self._all_handlers)
        for handlers in self._handlers.values():
            count += len(handlers)
        return count


# Global event bus instance
_global_event_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """Get the global event bus instance.

    Creates the instance on first call.
    """
    global _global_event_bus
    if _global_event_bus is None:
        _global_event_bus = EventBus()
    return _global_event_bus


def set_event_bus(bus: EventBus | None) -> EventBus | None:
    """Set the global event bus instance.

    Useful for testing or customization. Pass None to reset.

    Returns:
        The previous event bus instance
    """
    global _global_event_bus
    previous = _global_event_bus
    _global_event_bus = bus
    return previous


def reset_event_bus() -> None:
    """Reset the global event bus to a fresh instance.

    This clears all subscriptions and creates a new bus.
    """
    global _global_event_bus
    _global_event_bus = EventBus()


# Event type constants for common events
class EventTypes:
    """Constants for common event types."""

    # Run-level events
    RUN_CREATED = "RunCreated"
    RUN_STARTED = "RunStarted"
    RUN_FINISHED = "RunFinished"
    RUN_FAILED = "RunFailed"
    RUN_PAUSED = "RunPaused"
    RUN_RESUMED = "RunResumed"
    RUN_CANCELLED = "RunCancelled"

    # Node-level events
    NODE_READY = "NodeReady"
    NODE_STARTED = "NodeStarted"
    NODE_FINISHED = "NodeFinished"
    NODE_FAILED = "NodeFailed"
    NODE_SKIPPED = "NodeSkipped"
    NODE_CANCELLED = "NodeCancelled"

    # Cache events
    CACHE_HIT = "CacheHit"
    CACHE_MISS = "CacheMiss"
    CACHE_CORRUPT = "CacheCorrupt"
    CACHE_STORED = "CacheStored"

    # Approval events
    APPROVAL_REQUESTED = "ApprovalRequested"
    APPROVAL_DECIDED = "ApprovalDecided"

    # LLM events
    LLM_CALL_STARTED = "LLMCallStarted"
    LLM_CALL_FINISHED = "LLMCallFinished"

    # Tool events
    TOOL_CALL_STARTED = "ToolCallStarted"
    TOOL_CALL_FINISHED = "ToolCallFinished"

    # Retry events
    RETRY_SCHEDULED = "RetryScheduled"
    RETRY_ATTEMPT = "RetryAttempt"

    # Ralph loop events
    LOOP_ITERATION_STARTED = "LoopIterationStarted"
    LOOP_ITERATION_FINISHED = "LoopIterationFinished"
    LOOP_MAX_ITERATIONS_REACHED = "LoopMaxIterationsReached"


# Factory functions for creating common events
def run_started(run_id: str, target: str, node_count: int) -> Event:
    """Create a RunStarted event."""
    return Event(
        type=EventTypes.RUN_STARTED,
        run_id=run_id,
        payload={"target": target, "node_count": node_count},
    )


def run_finished(run_id: str, status: str, duration_ms: float | None = None) -> Event:
    """Create a RunFinished event."""
    payload: dict[str, Any] = {"status": status}
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    return Event(
        type=EventTypes.RUN_FINISHED,
        run_id=run_id,
        payload=payload,
    )


def run_failed(run_id: str, error: str, node_id: str | None = None) -> Event:
    """Create a RunFailed event."""
    return Event(
        type=EventTypes.RUN_FAILED,
        run_id=run_id,
        node_id=node_id,
        payload={"error": error},
    )


def node_started(run_id: str, node_id: str, workflow_name: str | None = None) -> Event:
    """Create a NodeStarted event."""
    payload: dict[str, Any] = {}
    if workflow_name:
        payload["workflow"] = workflow_name
    return Event(
        type=EventTypes.NODE_STARTED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def node_finished(
    run_id: str,
    node_id: str,
    duration_ms: float | None = None,
    cached: bool = False,
) -> Event:
    """Create a NodeFinished event."""
    payload: dict[str, Any] = {"cached": cached}
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    return Event(
        type=EventTypes.NODE_FINISHED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def node_failed(run_id: str, node_id: str, error: str) -> Event:
    """Create a NodeFailed event."""
    return Event(
        type=EventTypes.NODE_FAILED,
        run_id=run_id,
        node_id=node_id,
        payload={"error": error},
    )


def cache_hit(run_id: str, node_id: str, cache_key: str) -> Event:
    """Create a CacheHit event."""
    return Event(
        type=EventTypes.CACHE_HIT,
        run_id=run_id,
        node_id=node_id,
        payload={"cache_key": cache_key},
    )


def cache_miss(run_id: str, node_id: str, cache_key: str) -> Event:
    """Create a CacheMiss event."""
    return Event(
        type=EventTypes.CACHE_MISS,
        run_id=run_id,
        node_id=node_id,
        payload={"cache_key": cache_key},
    )


def llm_call_started(
    run_id: str,
    node_id: str,
    model: str,
    call_id: int | None = None,
) -> Event:
    """Create an LLMCallStarted event."""
    payload: dict[str, Any] = {"model": model}
    if call_id is not None:
        payload["call_id"] = call_id
    return Event(
        type=EventTypes.LLM_CALL_STARTED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def llm_call_finished(
    run_id: str,
    node_id: str,
    model: str,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
    call_id: int | None = None,
) -> Event:
    """Create an LLMCallFinished event."""
    payload: dict[str, Any] = {"model": model}
    if input_tokens is not None:
        payload["input_tokens"] = input_tokens
    if output_tokens is not None:
        payload["output_tokens"] = output_tokens
    if cost_usd is not None:
        payload["cost_usd"] = cost_usd
    if call_id is not None:
        payload["call_id"] = call_id
    return Event(
        type=EventTypes.LLM_CALL_FINISHED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def tool_call_started(
    run_id: str,
    node_id: str,
    tool_name: str,
    tool_call_id: int | None = None,
) -> Event:
    """Create a ToolCallStarted event."""
    payload: dict[str, Any] = {"tool": tool_name}
    if tool_call_id is not None:
        payload["tool_call_id"] = tool_call_id
    return Event(
        type=EventTypes.TOOL_CALL_STARTED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def tool_call_finished(
    run_id: str,
    node_id: str,
    tool_name: str,
    status: str,
    tool_call_id: int | None = None,
) -> Event:
    """Create a ToolCallFinished event."""
    payload: dict[str, Any] = {"tool": tool_name, "status": status}
    if tool_call_id is not None:
        payload["tool_call_id"] = tool_call_id
    return Event(
        type=EventTypes.TOOL_CALL_FINISHED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def retry_scheduled(
    run_id: str,
    node_id: str,
    attempt: int,
    delay_seconds: float,
    error: str,
) -> Event:
    """Create a RetryScheduled event."""
    return Event(
        type=EventTypes.RETRY_SCHEDULED,
        run_id=run_id,
        node_id=node_id,
        payload={
            "attempt": attempt,
            "delay_seconds": delay_seconds,
            "error": error,
        },
    )


def loop_iteration_started(
    run_id: str,
    node_id: str,
    iteration: int,
    input_hash: str | None = None,
) -> Event:
    """Create a LoopIterationStarted event."""
    payload: dict[str, Any] = {"iteration": iteration}
    if input_hash is not None:
        payload["input_hash"] = input_hash
    return Event(
        type=EventTypes.LOOP_ITERATION_STARTED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def loop_iteration_finished(
    run_id: str,
    node_id: str,
    iteration: int,
    output_hash: str | None = None,
    duration_ms: float | None = None,
    condition_met: bool = False,
) -> Event:
    """Create a LoopIterationFinished event."""
    payload: dict[str, Any] = {"iteration": iteration, "condition_met": condition_met}
    if output_hash is not None:
        payload["output_hash"] = output_hash
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    return Event(
        type=EventTypes.LOOP_ITERATION_FINISHED,
        run_id=run_id,
        node_id=node_id,
        payload=payload,
    )


def loop_max_iterations_reached(
    run_id: str,
    node_id: str,
    max_iterations: int,
    final_iteration: int,
) -> Event:
    """Create a LoopMaxIterationsReached event."""
    return Event(
        type=EventTypes.LOOP_MAX_ITERATIONS_REACHED,
        run_id=run_id,
        node_id=node_id,
        payload={
            "max_iterations": max_iterations,
            "final_iteration": final_iteration,
        },
    )
