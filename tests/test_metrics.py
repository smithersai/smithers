"""Tests for the Prometheus/OpenTelemetry metrics module."""

from __future__ import annotations

from http.client import HTTPConnection

import pytest

from smithers.events import Event, EventBus, EventTypes
from smithers.metrics import (
    CounterMetric,
    GaugeMetric,
    HistogramMetric,
    MetricLabels,
    MetricsCollector,
    get_metrics_collector,
    record_llm_call,
    record_tool_call,
    record_workflow_run,
    reset_metrics_collector,
    set_metrics_collector,
)


class TestMetricLabels:
    """Tests for MetricLabels."""

    def test_empty_labels(self) -> None:
        """Test empty labels."""
        labels = MetricLabels()
        assert labels.to_prometheus() == ""

    def test_single_label(self) -> None:
        """Test single label."""
        labels = MetricLabels({"status": "success"})
        assert labels.to_prometheus() == '{status="success"}'

    def test_multiple_labels_sorted(self) -> None:
        """Test multiple labels are sorted."""
        labels = MetricLabels({"z": "1", "a": "2", "m": "3"})
        result = labels.to_prometheus()
        assert result == '{a="2",m="3",z="1"}'

    def test_labels_hashable(self) -> None:
        """Test that labels can be used as dict keys."""
        labels1 = MetricLabels({"a": "1"})
        labels2 = MetricLabels({"a": "1"})
        labels3 = MetricLabels({"a": "2"})

        assert hash(labels1) == hash(labels2)
        assert labels1 == labels2
        assert labels1 != labels3

        d: dict[MetricLabels, int] = {labels1: 1}
        assert d[labels2] == 1


class TestCounterMetric:
    """Tests for CounterMetric."""

    def test_increment(self) -> None:
        """Test counter increment."""
        counter = CounterMetric(name="test_counter", help_text="A test counter")
        assert counter.get() == 0.0

        counter.inc()
        assert counter.get() == 1.0

        counter.inc(value=5.0)
        assert counter.get() == 6.0

    def test_increment_with_labels(self) -> None:
        """Test counter increment with labels."""
        counter = CounterMetric(name="test_counter", help_text="A test counter")

        counter.inc({"status": "success"})
        counter.inc({"status": "success"}, value=2.0)
        counter.inc({"status": "failure"})

        assert counter.get({"status": "success"}) == 3.0
        assert counter.get({"status": "failure"}) == 1.0
        assert counter.get({"status": "other"}) == 0.0

    def test_reset(self) -> None:
        """Test counter reset."""
        counter = CounterMetric(name="test_counter", help_text="A test counter")
        counter.inc({"status": "success"}, value=10.0)
        counter.inc({"status": "failure"}, value=5.0)

        counter.reset()

        assert counter.get({"status": "success"}) == 0.0
        assert counter.get({"status": "failure"}) == 0.0

    def test_export_prometheus(self) -> None:
        """Test Prometheus export format."""
        counter = CounterMetric(name="http_requests", help_text="Total HTTP requests")
        counter.inc({"method": "GET", "status": "200"}, value=100.0)
        counter.inc({"method": "POST", "status": "200"}, value=50.0)

        output = counter.export_prometheus()
        assert "# HELP http_requests Total HTTP requests" in output
        assert "# TYPE http_requests counter" in output
        assert 'http_requests{method="GET",status="200"} 100' in output
        assert 'http_requests{method="POST",status="200"} 50' in output


class TestGaugeMetric:
    """Tests for GaugeMetric."""

    def test_set(self) -> None:
        """Test gauge set."""
        gauge = GaugeMetric(name="test_gauge", help_text="A test gauge")
        gauge.set(42.0)
        assert gauge.get() == 42.0

        gauge.set(10.0)
        assert gauge.get() == 10.0

    def test_inc_dec(self) -> None:
        """Test gauge increment and decrement."""
        gauge = GaugeMetric(name="test_gauge", help_text="A test gauge")

        gauge.inc()
        assert gauge.get() == 1.0

        gauge.inc(value=4.0)
        assert gauge.get() == 5.0

        gauge.dec()
        assert gauge.get() == 4.0

        gauge.dec(value=2.0)
        assert gauge.get() == 2.0

    def test_export_prometheus(self) -> None:
        """Test Prometheus export format."""
        gauge = GaugeMetric(name="active_connections", help_text="Active connections")
        gauge.set(42.0, {"host": "server1"})
        gauge.set(23.0, {"host": "server2"})

        output = gauge.export_prometheus()
        assert "# HELP active_connections Active connections" in output
        assert "# TYPE active_connections gauge" in output
        assert 'active_connections{host="server1"} 42' in output
        assert 'active_connections{host="server2"} 23' in output


class TestHistogramMetric:
    """Tests for HistogramMetric."""

    def test_observe(self) -> None:
        """Test histogram observation."""
        histogram = HistogramMetric(
            name="request_duration",
            help_text="Request duration",
            buckets=[0.1, 0.5, 1.0],
        )

        histogram.observe(0.05)
        histogram.observe(0.3)
        histogram.observe(0.7)
        histogram.observe(1.5)

        assert histogram.get_count() == 4
        assert histogram.get_sum() == pytest.approx(2.55)

    def test_observe_with_labels(self) -> None:
        """Test histogram with labels."""
        histogram = HistogramMetric(
            name="request_duration",
            help_text="Request duration",
            buckets=[0.1, 0.5, 1.0],
        )

        histogram.observe(0.05, {"method": "GET"})
        histogram.observe(0.3, {"method": "GET"})
        histogram.observe(1.5, {"method": "POST"})

        assert histogram.get_count({"method": "GET"}) == 2
        assert histogram.get_count({"method": "POST"}) == 1
        assert histogram.get_sum({"method": "GET"}) == pytest.approx(0.35)

    def test_export_prometheus(self) -> None:
        """Test Prometheus export format."""
        histogram = HistogramMetric(
            name="request_duration",
            help_text="Request duration in seconds",
            buckets=[0.1, 0.5, 1.0],
        )

        histogram.observe(0.05)
        histogram.observe(0.3)
        histogram.observe(0.7)

        output = histogram.export_prometheus()
        assert "# HELP request_duration Request duration in seconds" in output
        assert "# TYPE request_duration histogram" in output
        assert 'request_duration_bucket{le="0.1"} 1' in output
        assert 'request_duration_bucket{le="0.5"} 2' in output
        assert 'request_duration_bucket{le="1.0"} 3' in output
        assert 'request_duration_bucket{le="+Inf"} 3' in output
        assert "request_duration_sum" in output
        assert "request_duration_count 3" in output


class TestMetricsCollector:
    """Tests for MetricsCollector."""

    def test_initialization(self) -> None:
        """Test collector initialization."""
        collector = MetricsCollector()
        assert collector.prefix == "smithers"
        assert collector.workflow_runs_total is not None
        assert collector.active_runs is not None

    def test_custom_prefix(self) -> None:
        """Test custom metric prefix."""
        collector = MetricsCollector(prefix="myapp")
        assert collector.workflow_runs_total.name == "myapp_workflow_runs_total"

    def test_record_run_started(self) -> None:
        """Test recording run start."""
        collector = MetricsCollector()
        collector.record_run_started("my_workflow", "run-123")

        assert (
            collector.workflow_runs_total.get({"workflow": "my_workflow", "status": "started"})
            == 1.0
        )
        assert collector.active_runs.get() == 1.0

    def test_record_run_completed(self) -> None:
        """Test recording run completion."""
        collector = MetricsCollector()
        collector.record_run_started("my_workflow", "run-123")
        collector.record_run_completed(
            "my_workflow", "success", duration_seconds=1.5, run_id="run-123"
        )

        assert (
            collector.workflow_runs_total.get({"workflow": "my_workflow", "status": "success"})
            == 1.0
        )
        assert collector.active_runs.get() == 0.0
        assert (
            collector.workflow_duration_seconds.get_count(
                {"workflow": "my_workflow", "status": "success"}
            )
            == 1
        )

    def test_record_node_execution(self) -> None:
        """Test recording node execution."""
        collector = MetricsCollector()
        collector.record_node_started("analyze", "my_workflow")
        collector.record_node_completed("analyze", "success", duration_seconds=0.5)

        assert (
            collector.node_executions_total.get(
                {"node": "analyze", "workflow": "my_workflow", "status": "started"}
            )
            == 1.0
        )
        assert collector.node_executions_total.get({"node": "analyze", "status": "success"}) == 1.0

    def test_record_cache_operations(self) -> None:
        """Test recording cache operations."""
        collector = MetricsCollector()
        collector.record_cache_operation("hit", "node1")
        collector.record_cache_operation("hit", "node2")
        collector.record_cache_operation("miss", "node3")

        assert collector.cache_operations_total.get({"operation": "hit", "node": "node1"}) == 1.0
        assert collector.cache_operations_total.get({"operation": "hit", "node": "node2"}) == 1.0
        assert collector.cache_operations_total.get({"operation": "miss", "node": "node3"}) == 1.0

    def test_record_llm_call(self) -> None:
        """Test recording LLM call."""
        collector = MetricsCollector()
        collector.record_llm_call(
            model="claude-3-opus",
            duration_seconds=2.5,
            input_tokens=1000,
            output_tokens=500,
            node_id="analyze",
        )

        assert collector.llm_calls_total.get({"model": "claude-3-opus", "node": "analyze"}) == 1.0
        assert collector.llm_tokens_total.get({"model": "claude-3-opus", "type": "input"}) == 1000.0
        assert collector.llm_tokens_total.get({"model": "claude-3-opus", "type": "output"}) == 500.0
        assert collector.llm_call_duration_seconds.get_count({"model": "claude-3-opus"}) == 1

    def test_record_tool_call(self) -> None:
        """Test recording tool call."""
        collector = MetricsCollector()
        collector.record_tool_call("Bash", "success", duration_seconds=0.1)
        collector.record_tool_call("Read", "success", duration_seconds=0.05)
        collector.record_tool_call("Bash", "failure", duration_seconds=0.2)

        assert collector.tool_calls_total.get({"tool": "Bash", "status": "success"}) == 1.0
        assert collector.tool_calls_total.get({"tool": "Bash", "status": "failure"}) == 1.0
        assert collector.tool_calls_total.get({"tool": "Read", "status": "success"}) == 1.0

    def test_record_retry_attempt(self) -> None:
        """Test recording retry attempts."""
        collector = MetricsCollector()
        collector.record_retry_attempt("node1", 1, "TimeoutError")
        collector.record_retry_attempt("node1", 2, "TimeoutError")

        assert (
            collector.retry_attempts_total.get(
                {"node": "node1", "attempt": "1", "error_type": "TimeoutError"}
            )
            == 1.0
        )
        assert (
            collector.retry_attempts_total.get(
                {"node": "node1", "attempt": "2", "error_type": "TimeoutError"}
            )
            == 1.0
        )

    def test_record_loop_iteration(self) -> None:
        """Test recording Ralph loop iterations."""
        collector = MetricsCollector()
        collector.record_loop_iteration("review_loop", 0, "continue")
        collector.record_loop_iteration("review_loop", 1, "continue")
        collector.record_loop_iteration("review_loop", 2, "met")

        assert (
            collector.loop_iterations_total.get({"loop": "review_loop", "status": "continue"})
            == 2.0
        )
        assert collector.loop_iterations_total.get({"loop": "review_loop", "status": "met"}) == 1.0

    def test_record_approvals(self) -> None:
        """Test recording approval operations."""
        collector = MetricsCollector()
        collector.record_approval_requested("run-1", "deploy")
        collector.record_approval_requested("run-1", "production")

        assert collector.pending_approvals.get() == 2.0

        collector.record_approval_decided("run-1", "deploy", approved=True)
        assert collector.pending_approvals.get() == 1.0
        assert collector.approvals_total.get({"status": "approved"}) == 1.0

        collector.record_approval_decided("run-1", "production", approved=False)
        assert collector.pending_approvals.get() == 0.0
        assert collector.approvals_total.get({"status": "rejected"}) == 1.0

    def test_reset(self) -> None:
        """Test resetting all metrics."""
        collector = MetricsCollector()
        collector.record_run_started("workflow", "run-1")
        collector.record_llm_call("claude", input_tokens=100, output_tokens=50)
        collector.record_approval_requested("run-1", "node")

        collector.reset()

        assert (
            collector.workflow_runs_total.get({"workflow": "workflow", "status": "started"}) == 0.0
        )
        assert collector.active_runs.get() == 0.0
        assert collector.pending_approvals.get() == 0.0
        assert collector.llm_tokens_total.get({"model": "claude", "type": "input"}) == 0.0


class TestMetricsCollectorExport:
    """Tests for metrics export."""

    def test_export_prometheus(self) -> None:
        """Test Prometheus export."""
        collector = MetricsCollector()
        collector.record_run_started("test_workflow", "run-1")
        collector.record_llm_call("claude-3-opus", input_tokens=1000)

        output = collector.export_prometheus()

        assert "# Smithers metrics" in output
        assert "smithers_workflow_runs_total" in output
        assert "smithers_llm_tokens_total" in output
        assert 'workflow="test_workflow"' in output
        assert 'model="claude-3-opus"' in output

    def test_export_opentelemetry(self) -> None:
        """Test OpenTelemetry export."""
        collector = MetricsCollector()
        collector.record_run_started("test_workflow", "run-1")
        collector.record_llm_call("claude-3-opus", input_tokens=1000)
        collector.workflow_duration_seconds.observe(1.5, {"workflow": "test", "status": "success"})

        output = collector.export_opentelemetry()

        assert "resource_metrics" in output
        assert len(output["resource_metrics"]) == 1

        resource = output["resource_metrics"][0]
        assert "resource" in resource
        assert "scope_metrics" in resource

        metrics = resource["scope_metrics"][0]["metrics"]
        assert len(metrics) > 0

        # Check that we have different metric types
        metric_names = [m["name"] for m in metrics]
        assert "smithers_workflow_runs_total" in metric_names
        assert "smithers_active_runs" in metric_names


class TestMetricsCollectorEventBus:
    """Tests for EventBus integration."""

    @pytest.fixture
    def event_bus(self) -> EventBus:
        """Create a fresh EventBus for testing."""
        return EventBus()

    @pytest.fixture
    def collector(self) -> MetricsCollector:
        """Create a fresh MetricsCollector."""
        return MetricsCollector()

    def test_attach_to_event_bus(self, collector: MetricsCollector, event_bus: EventBus) -> None:
        """Test attaching to EventBus."""
        collector.attach_to_event_bus(event_bus)

        # Check that subscriptions were created
        assert event_bus.subscriber_count() > 0

    def test_detach_from_event_bus(self, collector: MetricsCollector, event_bus: EventBus) -> None:
        """Test detaching from EventBus."""
        collector.attach_to_event_bus(event_bus)
        collector.detach_from_event_bus()

        # Subscriptions should be removed
        assert collector._event_bus is None

    @pytest.mark.asyncio
    async def test_run_started_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling RunStarted event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.RUN_STARTED,
            run_id="run-123",
            payload={"target": "my_workflow", "node_count": 5},
        )
        await event_bus.emit(event)

        assert (
            collector.workflow_runs_total.get({"workflow": "my_workflow", "status": "started"})
            == 1.0
        )
        assert collector.active_runs.get() == 1.0

    @pytest.mark.asyncio
    async def test_run_finished_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling RunFinished event."""
        collector.attach_to_event_bus(event_bus)

        # First start the run
        collector.record_run_started("my_workflow", "run-123")

        event = Event(
            type=EventTypes.RUN_FINISHED,
            run_id="run-123",
            payload={"status": "success", "duration_ms": 1500, "target": "my_workflow"},
        )
        await event_bus.emit(event)

        assert (
            collector.workflow_runs_total.get({"workflow": "my_workflow", "status": "success"})
            == 1.0
        )
        assert collector.active_runs.get() == 0.0

    @pytest.mark.asyncio
    async def test_node_started_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling NodeStarted event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.NODE_STARTED,
            run_id="run-123",
            node_id="analyze",
            payload={"workflow": "my_workflow"},
        )
        await event_bus.emit(event)

        assert (
            collector.node_executions_total.get(
                {"node": "analyze", "workflow": "my_workflow", "status": "started"}
            )
            == 1.0
        )

    @pytest.mark.asyncio
    async def test_node_finished_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling NodeFinished event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.NODE_FINISHED,
            run_id="run-123",
            node_id="analyze",
            payload={"duration_ms": 500, "cached": False},
        )
        await event_bus.emit(event)

        assert collector.node_executions_total.get({"node": "analyze", "status": "success"}) == 1.0

    @pytest.mark.asyncio
    async def test_node_finished_cached_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling NodeFinished event with cached=True."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.NODE_FINISHED,
            run_id="run-123",
            node_id="analyze",
            payload={"cached": True},
        )
        await event_bus.emit(event)

        assert (
            collector.node_executions_total.get(
                {"node": "analyze", "status": "cached", "cached": "true"}
            )
            == 1.0
        )

    @pytest.mark.asyncio
    async def test_cache_hit_event(self, collector: MetricsCollector, event_bus: EventBus) -> None:
        """Test handling CacheHit event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.CACHE_HIT,
            run_id="run-123",
            node_id="analyze",
            payload={"cache_key": "abc123"},
        )
        await event_bus.emit(event)

        assert collector.cache_operations_total.get({"operation": "hit", "node": "analyze"}) == 1.0

    @pytest.mark.asyncio
    async def test_cache_miss_event(self, collector: MetricsCollector, event_bus: EventBus) -> None:
        """Test handling CacheMiss event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.CACHE_MISS,
            run_id="run-123",
            node_id="analyze",
            payload={"cache_key": "abc123"},
        )
        await event_bus.emit(event)

        assert collector.cache_operations_total.get({"operation": "miss", "node": "analyze"}) == 1.0

    @pytest.mark.asyncio
    async def test_llm_call_finished_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling LLMCallFinished event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.LLM_CALL_FINISHED,
            run_id="run-123",
            node_id="analyze",
            payload={
                "model": "claude-3-opus",
                "input_tokens": 1000,
                "output_tokens": 500,
            },
        )
        await event_bus.emit(event)

        assert collector.llm_calls_total.get({"model": "claude-3-opus", "node": "analyze"}) == 1.0
        assert collector.llm_tokens_total.get({"model": "claude-3-opus", "type": "input"}) == 1000.0
        assert collector.llm_tokens_total.get({"model": "claude-3-opus", "type": "output"}) == 500.0

    @pytest.mark.asyncio
    async def test_tool_call_finished_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling ToolCallFinished event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.TOOL_CALL_FINISHED,
            run_id="run-123",
            node_id="implement",
            payload={"tool": "Bash", "status": "success"},
        )
        await event_bus.emit(event)

        assert (
            collector.tool_calls_total.get(
                {"tool": "Bash", "status": "success", "node": "implement"}
            )
            == 1.0
        )

    @pytest.mark.asyncio
    async def test_retry_scheduled_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling RetryScheduled event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.RETRY_SCHEDULED,
            run_id="run-123",
            node_id="flaky_node",
            payload={
                "attempt": 2,
                "delay_seconds": 1.0,
                "error": "TimeoutError: request timed out",
            },
        )
        await event_bus.emit(event)

        assert (
            collector.retry_attempts_total.get(
                {"node": "flaky_node", "attempt": "2", "error_type": "TimeoutError"}
            )
            == 1.0
        )

    @pytest.mark.asyncio
    async def test_loop_iteration_finished_event(
        self, collector: MetricsCollector, event_bus: EventBus
    ) -> None:
        """Test handling LoopIterationFinished event."""
        collector.attach_to_event_bus(event_bus)

        event = Event(
            type=EventTypes.LOOP_ITERATION_FINISHED,
            run_id="run-123",
            node_id="review_loop",
            payload={"iteration": 2, "condition_met": True, "duration_ms": 500},
        )
        await event_bus.emit(event)

        assert collector.loop_iterations_total.get({"loop": "review_loop", "status": "met"}) == 1.0

    @pytest.mark.asyncio
    async def test_approval_events(self, collector: MetricsCollector, event_bus: EventBus) -> None:
        """Test handling approval events."""
        collector.attach_to_event_bus(event_bus)

        # Request approval
        event1 = Event(
            type=EventTypes.APPROVAL_REQUESTED,
            run_id="run-123",
            node_id="deploy",
            payload={"prompt": "Deploy to production?"},
        )
        await event_bus.emit(event1)

        assert collector.pending_approvals.get() == 1.0

        # Decide approval
        event2 = Event(
            type=EventTypes.APPROVAL_DECIDED,
            run_id="run-123",
            node_id="deploy",
            payload={"approved": True},
        )
        await event_bus.emit(event2)

        assert collector.pending_approvals.get() == 0.0
        assert collector.approvals_total.get({"status": "approved"}) == 1.0


class TestMetricsCollectorServer:
    """Tests for HTTP server functionality."""

    def test_create_metrics_handler(self) -> None:
        """Test creating metrics handler."""
        collector = MetricsCollector()
        handler_class = collector.create_metrics_handler()

        assert handler_class is not None
        assert hasattr(handler_class, "do_GET")

    def test_start_stop_server(self) -> None:
        """Test starting and stopping server."""
        collector = MetricsCollector()

        # Start server
        server = collector.start_server(port=0)  # Use random port
        assert server is not None
        assert collector._server is not None
        assert collector._server_thread is not None
        assert collector._server_thread.is_alive()

        # Get the actual port
        port = server.server_address[1]

        # Stop server
        collector.stop_server()
        assert collector._server is None

    def test_server_metrics_endpoint(self) -> None:
        """Test /metrics endpoint."""
        collector = MetricsCollector()
        collector.record_run_started("test_workflow", "run-1")

        server = collector.start_server(port=0)
        port = server.server_address[1]

        try:
            # Make HTTP request
            conn = HTTPConnection("localhost", port)
            conn.request("GET", "/metrics")
            response = conn.getresponse()

            assert response.status == 200
            assert "text/plain" in response.getheader("Content-Type", "")

            body = response.read().decode("utf-8")
            assert "smithers_workflow_runs_total" in body
            assert "test_workflow" in body
        finally:
            collector.stop_server()

    def test_server_health_endpoint(self) -> None:
        """Test /health endpoint."""
        collector = MetricsCollector()
        server = collector.start_server(port=0)
        port = server.server_address[1]

        try:
            conn = HTTPConnection("localhost", port)
            conn.request("GET", "/health")
            response = conn.getresponse()

            assert response.status == 200
            assert response.read() == b"OK"
        finally:
            collector.stop_server()

    def test_server_404(self) -> None:
        """Test 404 for unknown paths."""
        collector = MetricsCollector()
        server = collector.start_server(port=0)
        port = server.server_address[1]

        try:
            conn = HTTPConnection("localhost", port)
            conn.request("GET", "/unknown")
            response = conn.getresponse()

            assert response.status == 404
        finally:
            collector.stop_server()

    def test_cannot_start_twice(self) -> None:
        """Test that starting server twice raises error."""
        collector = MetricsCollector()
        collector.start_server(port=0)

        try:
            with pytest.raises(RuntimeError, match="already running"):
                collector.start_server(port=0)
        finally:
            collector.stop_server()


class TestGlobalCollector:
    """Tests for global collector management."""

    def teardown_method(self) -> None:
        """Reset global collector after each test."""
        reset_metrics_collector()

    def test_get_metrics_collector(self) -> None:
        """Test getting global collector."""
        collector1 = get_metrics_collector()
        collector2 = get_metrics_collector()

        assert collector1 is collector2

    def test_set_metrics_collector(self) -> None:
        """Test setting global collector."""
        custom = MetricsCollector(prefix="custom")
        previous = set_metrics_collector(custom)

        assert get_metrics_collector() is custom
        assert previous is not None

    def test_reset_metrics_collector(self) -> None:
        """Test resetting global collector."""
        collector1 = get_metrics_collector()
        collector1.record_run_started("test", "run-1")

        reset_metrics_collector()
        collector2 = get_metrics_collector()

        assert collector1 is not collector2
        assert collector2.workflow_runs_total.get({"workflow": "test", "status": "started"}) == 0.0


class TestConvenienceFunctions:
    """Tests for convenience functions."""

    def teardown_method(self) -> None:
        """Reset global collector after each test."""
        reset_metrics_collector()

    def test_record_workflow_run(self) -> None:
        """Test record_workflow_run convenience function."""
        record_workflow_run("my_workflow", "success", duration_seconds=1.5)

        collector = get_metrics_collector()
        assert (
            collector.workflow_runs_total.get({"workflow": "my_workflow", "status": "success"})
            == 1.0
        )

    def test_record_llm_call(self) -> None:
        """Test record_llm_call convenience function."""
        record_llm_call("claude-3", duration_seconds=2.0, input_tokens=1000, output_tokens=500)

        collector = get_metrics_collector()
        assert collector.llm_calls_total.get({"model": "claude-3"}) == 1.0
        assert collector.llm_tokens_total.get({"model": "claude-3", "type": "input"}) == 1000.0

    def test_record_tool_call(self) -> None:
        """Test record_tool_call convenience function."""
        record_tool_call("Bash", "success", duration_seconds=0.1)

        collector = get_metrics_collector()
        assert collector.tool_calls_total.get({"tool": "Bash", "status": "success"}) == 1.0


class TestPrometheusExportFormat:
    """Tests for Prometheus export format correctness."""

    def test_counter_format(self) -> None:
        """Test counter export format matches Prometheus spec."""
        collector = MetricsCollector()
        collector.workflow_runs_total.inc({"workflow": "test", "status": "success"}, 5)

        output = collector.workflow_runs_total.export_prometheus()
        lines = output.split("\n")

        # Should have HELP, TYPE, and value lines
        assert any("# HELP" in line for line in lines)
        assert any("# TYPE" in line and "counter" in line for line in lines)
        assert any("smithers_workflow_runs_total" in line and "5" in line for line in lines)

    def test_histogram_bucket_format(self) -> None:
        """Test histogram bucket format."""
        collector = MetricsCollector()
        collector.workflow_duration_seconds.observe(0.5, {"workflow": "test", "status": "success"})
        collector.workflow_duration_seconds.observe(1.5, {"workflow": "test", "status": "success"})
        collector.workflow_duration_seconds.observe(5.5, {"workflow": "test", "status": "success"})

        output = collector.workflow_duration_seconds.export_prometheus()

        # Check bucket format
        assert "_bucket{" in output or '_bucket{workflow="test"' in output
        assert 'le="' in output
        assert 'le="+Inf"' in output
        assert "_sum" in output
        assert "_count" in output

    def test_empty_metrics_export(self) -> None:
        """Test export with no recorded metrics."""
        collector = MetricsCollector()
        output = collector.export_prometheus()

        # Should still have header comment
        assert "# Smithers metrics" in output


class TestOpenTelemetryExport:
    """Tests for OpenTelemetry export format."""

    def test_resource_attributes(self) -> None:
        """Test resource attributes in OTLP export."""
        collector = MetricsCollector()
        collector.record_run_started("test", "run-1")

        output = collector.export_opentelemetry()

        resource = output["resource_metrics"][0]["resource"]
        attrs = {a["key"]: a["value"]["string_value"] for a in resource["attributes"]}
        assert attrs["service.name"] == "smithers"

    def test_counter_otlp_format(self) -> None:
        """Test counter OTLP format."""
        collector = MetricsCollector()
        collector.workflow_runs_total.inc({"workflow": "test"}, 5)

        output = collector.export_opentelemetry()
        metrics = output["resource_metrics"][0]["scope_metrics"][0]["metrics"]

        counter_metric = next(m for m in metrics if m["name"] == "smithers_workflow_runs_total")
        assert "sum" in counter_metric
        assert counter_metric["sum"]["is_monotonic"] is True

    def test_gauge_otlp_format(self) -> None:
        """Test gauge OTLP format."""
        collector = MetricsCollector()
        collector.active_runs.set(5)

        output = collector.export_opentelemetry()
        metrics = output["resource_metrics"][0]["scope_metrics"][0]["metrics"]

        gauge_metric = next(m for m in metrics if m["name"] == "smithers_active_runs")
        assert "gauge" in gauge_metric

    def test_histogram_otlp_format(self) -> None:
        """Test histogram OTLP format."""
        collector = MetricsCollector()
        collector.workflow_duration_seconds.observe(1.5, {"workflow": "test", "status": "success"})

        output = collector.export_opentelemetry()
        metrics = output["resource_metrics"][0]["scope_metrics"][0]["metrics"]

        hist_metric = next(m for m in metrics if m["name"] == "smithers_workflow_duration_seconds")
        assert "histogram" in hist_metric
        assert "bucket_counts" in hist_metric["histogram"]["data_points"][0]
        assert "explicit_bounds" in hist_metric["histogram"]["data_points"][0]
