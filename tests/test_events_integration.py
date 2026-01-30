"""Integration tests for EventBus with workflow execution."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import build_graph, workflow
from smithers.events import Event, EventTypes, get_event_bus, reset_event_bus
from smithers.executor import run_graph_with_store
from smithers.store.sqlite import SqliteStore
from smithers.workflow import clear_registry


class IntegrationOutput(BaseModel):
    value: str


class AnalysisOutput(BaseModel):
    files: list[str]
    summary: str


class ImplementOutput(BaseModel):
    result: str


@pytest.fixture(autouse=True)
def clean_state() -> None:
    """Reset registries before each test."""
    clear_registry()
    reset_event_bus()
    yield
    clear_registry()
    reset_event_bus()


@pytest.fixture
def tmp_store(tmp_path) -> SqliteStore:
    """Create a temporary SQLite store."""
    return SqliteStore(tmp_path / "test.db")


class TestEventBusIntegration:
    """Test EventBus integration with workflow execution."""

    @pytest.mark.asyncio
    async def test_events_delivered_to_subscribers(self, tmp_store: SqliteStore) -> None:
        """Test that workflow events are delivered to EventBus subscribers."""

        @workflow
        async def simple_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(simple_workflow)

        received_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe_all(lambda e: received_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        # Should receive multiple events
        assert len(received_events) > 0

        # Check event types
        event_types = [e.type for e in received_events]
        assert "RunStarted" in event_types
        assert "NodeReady" in event_types
        assert "NodeStarted" in event_types
        assert "NodeFinished" in event_types
        assert "RunFinished" in event_types

    @pytest.mark.asyncio
    async def test_node_events_have_correct_node_id(self, tmp_store: SqliteStore) -> None:
        """Test that node events have the correct node_id."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        received_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe(EventTypes.NODE_STARTED, lambda e: received_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        assert len(received_events) == 1
        assert received_events[0].node_id == "my_workflow"
        assert received_events[0].run_id is not None

    @pytest.mark.asyncio
    async def test_run_events_have_no_node_id(self, tmp_store: SqliteStore) -> None:
        """Test that run-level events have node_id=None."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        run_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("RunStarted", lambda e: run_events.append(e))
        bus.subscribe("RunFinished", lambda e: run_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        assert len(run_events) == 2
        for event in run_events:
            assert event.node_id is None

    @pytest.mark.asyncio
    async def test_events_have_sqlite_event_id(self, tmp_store: SqliteStore) -> None:
        """Test that events include the SQLite event_id."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        received_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe_all(lambda e: received_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        # All events should have event_id from SQLite
        for event in received_events:
            assert event.event_id is not None
            assert event.event_id > 0

    @pytest.mark.asyncio
    async def test_filtered_event_subscription(self, tmp_store: SqliteStore) -> None:
        """Test subscribing to specific event types."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        node_started: list[Event] = []
        node_finished: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("NodeStarted", lambda e: node_started.append(e))
        bus.subscribe("NodeFinished", lambda e: node_finished.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        assert len(node_started) == 1
        assert len(node_finished) == 1
        assert node_started[0].type == "NodeStarted"
        assert node_finished[0].type == "NodeFinished"

    @pytest.mark.asyncio
    async def test_events_include_payload(self, tmp_store: SqliteStore) -> None:
        """Test that events include relevant payload data."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        run_started_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("RunStarted", lambda e: run_started_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        assert len(run_started_events) == 1
        assert run_started_events[0].payload["target"] == "my_workflow"

    @pytest.mark.asyncio
    async def test_unsubscribe_stops_events(self, tmp_store: SqliteStore) -> None:
        """Test that unsubscribing stops event delivery."""

        @workflow
        async def my_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="test")

        graph = build_graph(my_workflow)

        received_events: list[Event] = []
        bus = get_event_bus()
        sub = bus.subscribe_all(lambda e: received_events.append(e))

        # Unsubscribe immediately
        sub.unsubscribe()

        await run_graph_with_store(graph, store=tmp_store)

        # Should not receive any events
        assert len(received_events) == 0


class TestEventBusWithDependencies:
    """Test EventBus with multi-node workflows."""

    @pytest.mark.asyncio
    async def test_events_for_each_node(self, tmp_store: SqliteStore) -> None:
        """Test that events are emitted for each node in a dependency chain."""

        @workflow
        async def step_one() -> AnalysisOutput:
            return AnalysisOutput(files=["a.py"], summary="test")

        @workflow
        async def step_two(s1: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(result=s1.summary)

        graph = build_graph(step_two)

        node_started: list[Event] = []
        node_finished: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("NodeStarted", lambda e: node_started.append(e))
        bus.subscribe("NodeFinished", lambda e: node_finished.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        # Should have events for both nodes
        assert len(node_started) == 2
        assert len(node_finished) == 2

        # Check node IDs
        started_nodes = {e.node_id for e in node_started}
        assert "step_one" in started_nodes
        assert "step_two" in started_nodes


class TestEventBusWithErrors:
    """Test EventBus behavior when workflows fail."""

    @pytest.mark.asyncio
    async def test_failed_events_delivered(self, tmp_store: SqliteStore) -> None:
        """Test that NodeFailed and RunFailed events are delivered."""

        @workflow
        async def failing_workflow() -> IntegrationOutput:
            raise ValueError("Intentional failure")

        graph = build_graph(failing_workflow)

        failed_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("NodeFailed", lambda e: failed_events.append(e))
        bus.subscribe("RunFailed", lambda e: failed_events.append(e))

        with pytest.raises(Exception):
            await run_graph_with_store(graph, store=tmp_store)

        # Should have NodeFailed and RunFailed events
        event_types = [e.type for e in failed_events]
        assert "NodeFailed" in event_types
        assert "RunFailed" in event_types

    @pytest.mark.asyncio
    async def test_failed_event_includes_error_info(self, tmp_store: SqliteStore) -> None:
        """Test that NodeFailed events include error information."""

        @workflow
        async def failing_workflow() -> IntegrationOutput:
            raise ValueError("Test error message")

        graph = build_graph(failing_workflow)

        failed_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("NodeFailed", lambda e: failed_events.append(e))

        with pytest.raises(Exception):
            await run_graph_with_store(graph, store=tmp_store)

        assert len(failed_events) == 1
        assert "error" in failed_events[0].payload
        assert "Test error message" in failed_events[0].payload["error"]
        assert failed_events[0].payload["error_type"] == "ValueError"


class TestEventBusWithCaching:
    """Test EventBus with caching enabled."""

    @pytest.mark.asyncio
    async def test_cache_events_delivered(self, tmp_store: SqliteStore, tmp_path) -> None:
        """Test that cache-related events are delivered."""
        from smithers.cache import SqliteCache

        cache = SqliteCache(tmp_path / "cache.db")

        @workflow
        async def cached_workflow() -> IntegrationOutput:
            return IntegrationOutput(value="cached")

        graph = build_graph(cached_workflow)

        all_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe_all(lambda e: all_events.append(e))

        # First run - should not hit cache
        await run_graph_with_store(graph, store=tmp_store, cache=cache)

        event_types = [e.type for e in all_events]
        # First run should have normal execution events
        assert "NodeStarted" in event_types
        assert "NodeFinished" in event_types

        # Clear for second run
        all_events.clear()
        reset_event_bus()
        bus = get_event_bus()
        bus.subscribe_all(lambda e: all_events.append(e))

        # Second run - should hit cache
        new_store = SqliteStore(tmp_path / "test2.db")
        await run_graph_with_store(graph, store=new_store, cache=cache)

        event_types = [e.type for e in all_events]
        # Second run should have cache event
        assert "NodeCached" in event_types


class TestEventBusWithRetries:
    """Test EventBus with retry events."""

    @pytest.mark.asyncio
    async def test_retry_events_delivered(self, tmp_store: SqliteStore) -> None:
        """Test that retry events are delivered during retries."""
        from smithers.types import RetryPolicy
        from smithers.workflow import retry

        attempt_count = 0

        @workflow
        @retry(RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        async def retrying_workflow() -> IntegrationOutput:
            nonlocal attempt_count
            attempt_count += 1
            if attempt_count < 3:
                raise ValueError("Retry me")
            return IntegrationOutput(value="success")

        graph = build_graph(retrying_workflow)

        retry_events: list[Event] = []
        bus = get_event_bus()
        bus.subscribe("NodeRetrying", lambda e: retry_events.append(e))

        await run_graph_with_store(graph, store=tmp_store)

        # Should have retry events
        assert len(retry_events) == 2  # Two retries before success

        # Check retry event payload
        for i, event in enumerate(retry_events, start=2):
            assert event.payload["attempt"] == i
            assert event.payload["max_attempts"] == 3
