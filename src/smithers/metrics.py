"""Prometheus and OpenTelemetry metrics export for Smithers.

This module provides production-grade observability by exposing workflow
execution metrics in standard formats that can be scraped by Prometheus
or exported via OpenTelemetry.

Metrics exported:
- smithers_workflow_runs_total: Counter of workflow runs by status
- smithers_node_executions_total: Counter of node executions by status
- smithers_llm_calls_total: Counter of LLM calls by model
- smithers_tool_calls_total: Counter of tool invocations by name and status
- smithers_cache_operations_total: Counter of cache hits/misses
- smithers_workflow_duration_seconds: Histogram of workflow run durations
- smithers_node_duration_seconds: Histogram of node execution durations
- smithers_llm_call_duration_seconds: Histogram of LLM call durations
- smithers_llm_tokens_total: Counter of tokens by type (input/output) and model
- smithers_active_runs: Gauge of currently active runs
- smithers_pending_approvals: Gauge of pending human approvals

Example usage:
    from smithers.metrics import MetricsCollector, get_metrics_collector

    # Get the global metrics collector
    collector = get_metrics_collector()

    # Start the HTTP server for Prometheus scraping
    await collector.start_server(port=9090)

    # Or export metrics as text
    metrics_text = collector.export_prometheus()

    # Integrate with EventBus for automatic metric updates
    collector.attach_to_event_bus()
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from typing import Any

from smithers.events import Event, EventBus, EventTypes, get_event_bus


class MetricType(str, Enum):
    """Type of metric."""

    COUNTER = "counter"
    GAUGE = "gauge"
    HISTOGRAM = "histogram"
    SUMMARY = "summary"


@dataclass
class MetricLabels:
    """Label set for a metric."""

    labels: dict[str, str] = field(default_factory=lambda: {})

    def __hash__(self) -> int:
        return hash(frozenset(self.labels.items()))

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, MetricLabels):
            return False
        return self.labels == other.labels

    def to_prometheus(self) -> str:
        """Format labels for Prometheus exposition format."""
        if not self.labels:
            return ""
        parts = [f'{k}="{v}"' for k, v in sorted(self.labels.items())]
        return "{" + ",".join(parts) + "}"


@dataclass
class CounterMetric:
    """A counter metric that only goes up."""

    name: str
    help_text: str
    values: dict[MetricLabels, float] = field(default_factory=lambda: {})

    def inc(self, labels: dict[str, str] | None = None, value: float = 1.0) -> None:
        """Increment the counter."""
        key = MetricLabels(labels or {})
        self.values[key] = self.values.get(key, 0.0) + value

    def get(self, labels: dict[str, str] | None = None) -> float:
        """Get the current value."""
        key = MetricLabels(labels or {})
        return self.values.get(key, 0.0)

    def reset(self) -> None:
        """Reset all values (useful for testing)."""
        self.values.clear()

    def export_prometheus(self) -> str:
        """Export in Prometheus text format."""
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} counter",
        ]
        for labels, value in sorted(self.values.items(), key=lambda x: str(x[0].labels)):
            label_str = labels.to_prometheus()
            lines.append(f"{self.name}{label_str} {value}")
        return "\n".join(lines)


@dataclass
class GaugeMetric:
    """A gauge metric that can go up or down."""

    name: str
    help_text: str
    values: dict[MetricLabels, float] = field(default_factory=lambda: {})

    def set(self, value: float, labels: dict[str, str] | None = None) -> None:
        """Set the gauge value."""
        key = MetricLabels(labels or {})
        self.values[key] = value

    def inc(self, labels: dict[str, str] | None = None, value: float = 1.0) -> None:
        """Increment the gauge."""
        key = MetricLabels(labels or {})
        self.values[key] = self.values.get(key, 0.0) + value

    def dec(self, labels: dict[str, str] | None = None, value: float = 1.0) -> None:
        """Decrement the gauge."""
        key = MetricLabels(labels or {})
        self.values[key] = self.values.get(key, 0.0) - value

    def get(self, labels: dict[str, str] | None = None) -> float:
        """Get the current value."""
        key = MetricLabels(labels or {})
        return self.values.get(key, 0.0)

    def reset(self) -> None:
        """Reset all values."""
        self.values.clear()

    def export_prometheus(self) -> str:
        """Export in Prometheus text format."""
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} gauge",
        ]
        for labels, value in sorted(self.values.items(), key=lambda x: str(x[0].labels)):
            label_str = labels.to_prometheus()
            lines.append(f"{self.name}{label_str} {value}")
        return "\n".join(lines)


@dataclass
class HistogramBucket:
    """A bucket in a histogram."""

    le: float  # less than or equal
    count: int = 0


@dataclass
class HistogramMetric:
    """A histogram metric for measuring distributions."""

    name: str
    help_text: str
    buckets: list[float] = field(
        default_factory=lambda: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
    )
    observations: dict[MetricLabels, list[float]] = field(default_factory=lambda: {})

    def observe(self, value: float, labels: dict[str, str] | None = None) -> None:
        """Record an observation."""
        key = MetricLabels(labels or {})
        if key not in self.observations:
            self.observations[key] = []
        self.observations[key].append(value)

    def get_count(self, labels: dict[str, str] | None = None) -> int:
        """Get the count of observations."""
        key = MetricLabels(labels or {})
        return len(self.observations.get(key, []))

    def get_sum(self, labels: dict[str, str] | None = None) -> float:
        """Get the sum of observations."""
        key = MetricLabels(labels or {})
        return sum(self.observations.get(key, []))

    def reset(self) -> None:
        """Reset all observations."""
        self.observations.clear()

    def export_prometheus(self) -> str:
        """Export in Prometheus text format."""
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} histogram",
        ]

        for labels, values in sorted(self.observations.items(), key=lambda x: str(x[0].labels)):
            label_str = labels.to_prometheus()
            label_prefix = label_str[:-1] if label_str else ""

            # Calculate bucket counts
            for bucket_le in self.buckets:
                bucket_count = sum(1 for v in values if v <= bucket_le)
                if label_prefix:
                    lines.append(
                        f'{self.name}_bucket{label_prefix},le="{bucket_le}"}} {bucket_count}'
                    )
                else:
                    lines.append(f'{self.name}_bucket{{le="{bucket_le}"}} {bucket_count}')

            # +Inf bucket
            if label_prefix:
                lines.append(f'{self.name}_bucket{label_prefix},le="+Inf"}} {len(values)}')
            else:
                lines.append(f'{self.name}_bucket{{le="+Inf"}} {len(values)}')

            # Sum and count
            total = sum(values)
            lines.append(f"{self.name}_sum{label_str} {total}")
            lines.append(f"{self.name}_count{label_str} {len(values)}")

        return "\n".join(lines)


class MetricsCollector:
    """Collector for Smithers metrics.

    This class manages all metrics and provides methods for exporting
    them in Prometheus format and integrating with the EventBus.

    Example:
        collector = MetricsCollector()

        # Manually record metrics
        collector.record_run_started("my_workflow")
        collector.record_run_completed("my_workflow", "success", duration_seconds=1.5)

        # Or attach to EventBus for automatic updates
        collector.attach_to_event_bus()

        # Export for Prometheus
        print(collector.export_prometheus())
    """

    def __init__(self, prefix: str = "smithers") -> None:
        """Initialize the metrics collector.

        Args:
            prefix: Prefix for all metric names (default: "smithers")
        """
        self.prefix = prefix
        self._event_bus: EventBus | None = None
        self._subscription_ids: list[str] = []
        self._server: HTTPServer | None = None
        self._server_thread: Thread | None = None

        # Active tracking for gauges
        self._active_runs: set[str] = set()
        self._pending_approvals: set[tuple[str, str]] = set()

        # Initialize metrics
        self._init_metrics()

    def _init_metrics(self) -> None:
        """Initialize all metric objects."""
        p = self.prefix

        # Counters
        self.workflow_runs_total = CounterMetric(
            name=f"{p}_workflow_runs_total",
            help_text="Total number of workflow runs",
        )
        self.node_executions_total = CounterMetric(
            name=f"{p}_node_executions_total",
            help_text="Total number of node executions",
        )
        self.llm_calls_total = CounterMetric(
            name=f"{p}_llm_calls_total",
            help_text="Total number of LLM API calls",
        )
        self.tool_calls_total = CounterMetric(
            name=f"{p}_tool_calls_total",
            help_text="Total number of tool invocations",
        )
        self.cache_operations_total = CounterMetric(
            name=f"{p}_cache_operations_total",
            help_text="Total number of cache operations",
        )
        self.llm_tokens_total = CounterMetric(
            name=f"{p}_llm_tokens_total",
            help_text="Total number of LLM tokens",
        )
        self.retry_attempts_total = CounterMetric(
            name=f"{p}_retry_attempts_total",
            help_text="Total number of retry attempts",
        )
        self.loop_iterations_total = CounterMetric(
            name=f"{p}_loop_iterations_total",
            help_text="Total number of Ralph loop iterations",
        )
        self.approvals_total = CounterMetric(
            name=f"{p}_approvals_total",
            help_text="Total number of approval decisions",
        )

        # Gauges
        self.active_runs = GaugeMetric(
            name=f"{p}_active_runs",
            help_text="Number of currently active runs",
        )
        self.pending_approvals = GaugeMetric(
            name=f"{p}_pending_approvals",
            help_text="Number of pending human approvals",
        )

        # Histograms
        self.workflow_duration_seconds = HistogramMetric(
            name=f"{p}_workflow_duration_seconds",
            help_text="Duration of workflow runs in seconds",
            buckets=[0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
        )
        self.node_duration_seconds = HistogramMetric(
            name=f"{p}_node_duration_seconds",
            help_text="Duration of node executions in seconds",
            buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
        )
        self.llm_call_duration_seconds = HistogramMetric(
            name=f"{p}_llm_call_duration_seconds",
            help_text="Duration of LLM API calls in seconds",
            buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
        )
        self.tool_call_duration_seconds = HistogramMetric(
            name=f"{p}_tool_call_duration_seconds",
            help_text="Duration of tool invocations in seconds",
            buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0],
        )

    def reset(self) -> None:
        """Reset all metrics (useful for testing)."""
        self.workflow_runs_total.reset()
        self.node_executions_total.reset()
        self.llm_calls_total.reset()
        self.tool_calls_total.reset()
        self.cache_operations_total.reset()
        self.llm_tokens_total.reset()
        self.retry_attempts_total.reset()
        self.loop_iterations_total.reset()
        self.approvals_total.reset()
        self.active_runs.reset()
        self.pending_approvals.reset()
        self.workflow_duration_seconds.reset()
        self.node_duration_seconds.reset()
        self.llm_call_duration_seconds.reset()
        self.tool_call_duration_seconds.reset()
        self._active_runs.clear()
        self._pending_approvals.clear()

    # ==================== Manual Recording Methods ====================

    def record_run_started(
        self,
        workflow_name: str,
        run_id: str | None = None,
    ) -> None:
        """Record a workflow run starting."""
        self.workflow_runs_total.inc({"workflow": workflow_name, "status": "started"})
        self.active_runs.inc()
        if run_id:
            self._active_runs.add(run_id)

    def record_run_completed(
        self,
        workflow_name: str,
        status: str,
        duration_seconds: float | None = None,
        run_id: str | None = None,
    ) -> None:
        """Record a workflow run completing."""
        self.workflow_runs_total.inc({"workflow": workflow_name, "status": status})
        self.active_runs.dec()
        if run_id and run_id in self._active_runs:
            self._active_runs.discard(run_id)
        if duration_seconds is not None:
            self.workflow_duration_seconds.observe(
                duration_seconds, {"workflow": workflow_name, "status": status}
            )

    def record_node_started(
        self,
        node_id: str,
        workflow_name: str | None = None,
    ) -> None:
        """Record a node execution starting."""
        labels = {"node": node_id}
        if workflow_name:
            labels["workflow"] = workflow_name
        self.node_executions_total.inc({**labels, "status": "started"})

    def record_node_completed(
        self,
        node_id: str,
        status: str,
        duration_seconds: float | None = None,
        cached: bool = False,
        workflow_name: str | None = None,
    ) -> None:
        """Record a node execution completing."""
        labels: dict[str, str] = {"node": node_id, "status": status}
        if workflow_name:
            labels["workflow"] = workflow_name
        if cached:
            labels["cached"] = "true"
        self.node_executions_total.inc(labels)
        if duration_seconds is not None:
            self.node_duration_seconds.observe(
                duration_seconds, {"node": node_id, "status": status}
            )

    def record_cache_operation(
        self,
        operation: str,
        node_id: str | None = None,
    ) -> None:
        """Record a cache operation (hit/miss/stored/corrupt)."""
        labels: dict[str, str] = {"operation": operation}
        if node_id:
            labels["node"] = node_id
        self.cache_operations_total.inc(labels)

    def record_llm_call(
        self,
        model: str,
        duration_seconds: float | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        node_id: str | None = None,
    ) -> None:
        """Record an LLM API call."""
        labels: dict[str, str] = {"model": model}
        if node_id:
            labels["node"] = node_id
        self.llm_calls_total.inc(labels)

        if duration_seconds is not None:
            self.llm_call_duration_seconds.observe(duration_seconds, {"model": model})

        if input_tokens is not None:
            self.llm_tokens_total.inc({"model": model, "type": "input"}, input_tokens)
        if output_tokens is not None:
            self.llm_tokens_total.inc({"model": model, "type": "output"}, output_tokens)

    def record_tool_call(
        self,
        tool_name: str,
        status: str,
        duration_seconds: float | None = None,
        node_id: str | None = None,
    ) -> None:
        """Record a tool invocation."""
        labels: dict[str, str] = {"tool": tool_name, "status": status}
        if node_id:
            labels["node"] = node_id
        self.tool_calls_total.inc(labels)

        if duration_seconds is not None:
            self.tool_call_duration_seconds.observe(
                duration_seconds, {"tool": tool_name, "status": status}
            )

    def record_retry_attempt(
        self,
        node_id: str,
        attempt: int,
        error_type: str | None = None,
    ) -> None:
        """Record a retry attempt."""
        labels: dict[str, str] = {"node": node_id, "attempt": str(attempt)}
        if error_type:
            labels["error_type"] = error_type
        self.retry_attempts_total.inc(labels)

    def record_loop_iteration(
        self,
        loop_node_id: str,
        iteration: int,
        status: str = "completed",
        duration_seconds: float | None = None,
    ) -> None:
        """Record a Ralph loop iteration."""
        labels = {"loop": loop_node_id, "status": status}
        self.loop_iterations_total.inc(labels)

    def record_approval_requested(
        self,
        run_id: str,
        node_id: str,
    ) -> None:
        """Record an approval request."""
        self.pending_approvals.inc()
        self._pending_approvals.add((run_id, node_id))

    def record_approval_decided(
        self,
        run_id: str,
        node_id: str,
        approved: bool,
    ) -> None:
        """Record an approval decision."""
        status = "approved" if approved else "rejected"
        self.approvals_total.inc({"status": status})
        self.pending_approvals.dec()
        self._pending_approvals.discard((run_id, node_id))

    # ==================== EventBus Integration ====================

    def attach_to_event_bus(self, bus: EventBus | None = None) -> None:
        """Attach to an EventBus for automatic metric updates.

        Args:
            bus: EventBus to attach to (uses global bus if None)
        """
        if self._event_bus is not None:
            self.detach_from_event_bus()

        self._event_bus = bus or get_event_bus()

        # Subscribe to relevant events
        handlers = [
            (EventTypes.RUN_STARTED, self._on_run_started),
            (EventTypes.RUN_FINISHED, self._on_run_finished),
            (EventTypes.RUN_FAILED, self._on_run_failed),
            (EventTypes.NODE_STARTED, self._on_node_started),
            (EventTypes.NODE_FINISHED, self._on_node_finished),
            (EventTypes.NODE_FAILED, self._on_node_failed),
            (EventTypes.CACHE_HIT, self._on_cache_hit),
            (EventTypes.CACHE_MISS, self._on_cache_miss),
            (EventTypes.LLM_CALL_FINISHED, self._on_llm_call_finished),
            (EventTypes.TOOL_CALL_FINISHED, self._on_tool_call_finished),
            (EventTypes.RETRY_SCHEDULED, self._on_retry_scheduled),
            (EventTypes.LOOP_ITERATION_FINISHED, self._on_loop_iteration_finished),
            (EventTypes.APPROVAL_REQUESTED, self._on_approval_requested),
            (EventTypes.APPROVAL_DECIDED, self._on_approval_decided),
        ]

        for event_type, handler in handlers:
            sub = self._event_bus.subscribe(event_type, handler)
            self._subscription_ids.append(sub.id)

    def detach_from_event_bus(self) -> None:
        """Detach from the EventBus."""
        if self._event_bus is None:
            return

        # Unsubscribe all handlers
        # Note: We need to find subscriptions by ID since we stored IDs
        for event_type_handlers in self._event_bus._handlers.values():
            for sub in list(event_type_handlers):
                if sub.id in self._subscription_ids:
                    self._event_bus.unsubscribe(sub)

        self._subscription_ids.clear()
        self._event_bus = None

    def _on_run_started(self, event: Event) -> None:
        """Handle RunStarted event."""
        target = event.payload.get("target", "unknown")
        self.record_run_started(target, event.run_id)

    def _on_run_finished(self, event: Event) -> None:
        """Handle RunFinished event."""
        status = event.payload.get("status", "success")
        duration_ms = event.payload.get("duration_ms")
        duration_s = duration_ms / 1000.0 if duration_ms else None
        # Get workflow name from payload or use "unknown"
        workflow = event.payload.get("target", "unknown")
        self.record_run_completed(workflow, status, duration_s, event.run_id)

    def _on_run_failed(self, event: Event) -> None:
        """Handle RunFailed event."""
        workflow = event.payload.get("target", "unknown")
        self.record_run_completed(workflow, "failed", run_id=event.run_id)

    def _on_node_started(self, event: Event) -> None:
        """Handle NodeStarted event."""
        node_id = event.node_id or "unknown"
        workflow = event.payload.get("workflow")
        self.record_node_started(node_id, workflow)

    def _on_node_finished(self, event: Event) -> None:
        """Handle NodeFinished event."""
        node_id = event.node_id or "unknown"
        duration_ms = event.payload.get("duration_ms")
        duration_s = duration_ms / 1000.0 if duration_ms else None
        cached = event.payload.get("cached", False)
        status = "cached" if cached else "success"
        self.record_node_completed(node_id, status, duration_s, cached)

    def _on_node_failed(self, event: Event) -> None:
        """Handle NodeFailed event."""
        node_id = event.node_id or "unknown"
        self.record_node_completed(node_id, "failed")

    def _on_cache_hit(self, event: Event) -> None:
        """Handle CacheHit event."""
        self.record_cache_operation("hit", event.node_id)

    def _on_cache_miss(self, event: Event) -> None:
        """Handle CacheMiss event."""
        self.record_cache_operation("miss", event.node_id)

    def _on_llm_call_finished(self, event: Event) -> None:
        """Handle LLMCallFinished event."""
        model = event.payload.get("model", "unknown")
        input_tokens = event.payload.get("input_tokens")
        output_tokens = event.payload.get("output_tokens")
        # Duration would need to be calculated from start/end if available
        self.record_llm_call(
            model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            node_id=event.node_id,
        )

    def _on_tool_call_finished(self, event: Event) -> None:
        """Handle ToolCallFinished event."""
        tool_name = event.payload.get("tool", "unknown")
        status = event.payload.get("status", "success")
        self.record_tool_call(tool_name, status, node_id=event.node_id)

    def _on_retry_scheduled(self, event: Event) -> None:
        """Handle RetryScheduled event."""
        node_id = event.node_id or "unknown"
        attempt = event.payload.get("attempt", 1)
        error = event.payload.get("error", "")
        # Extract error type from error message if available
        error_type = error.split(":")[0] if ":" in error else "unknown"
        self.record_retry_attempt(node_id, attempt, error_type)

    def _on_loop_iteration_finished(self, event: Event) -> None:
        """Handle LoopIterationFinished event."""
        node_id = event.node_id or "unknown"
        iteration = event.payload.get("iteration", 0)
        status = "met" if event.payload.get("condition_met") else "continue"
        duration_ms = event.payload.get("duration_ms")
        duration_s = duration_ms / 1000.0 if duration_ms else None
        self.record_loop_iteration(node_id, iteration, status, duration_s)

    def _on_approval_requested(self, event: Event) -> None:
        """Handle ApprovalRequested event."""
        node_id = event.node_id or "unknown"
        self.record_approval_requested(event.run_id, node_id)

    def _on_approval_decided(self, event: Event) -> None:
        """Handle ApprovalDecided event."""
        node_id = event.node_id or "unknown"
        approved = event.payload.get("approved", False)
        self.record_approval_decided(event.run_id, node_id, approved)

    # ==================== Export Methods ====================

    def export_prometheus(self) -> str:
        """Export all metrics in Prometheus text exposition format.

        Returns:
            Multi-line string in Prometheus format
        """
        metrics = [
            self.workflow_runs_total,
            self.node_executions_total,
            self.llm_calls_total,
            self.tool_calls_total,
            self.cache_operations_total,
            self.llm_tokens_total,
            self.retry_attempts_total,
            self.loop_iterations_total,
            self.approvals_total,
            self.active_runs,
            self.pending_approvals,
            self.workflow_duration_seconds,
            self.node_duration_seconds,
            self.llm_call_duration_seconds,
            self.tool_call_duration_seconds,
        ]

        parts = []
        for metric in metrics:
            exported = metric.export_prometheus()
            if exported and any(line for line in exported.split("\n") if not line.startswith("#")):
                parts.append(exported)

        # Add a comment with metadata
        from datetime import UTC

        header = f"# Smithers metrics - exported at {datetime.now(UTC).isoformat()}"
        return header + "\n\n" + "\n\n".join(parts) if parts else header

    def export_opentelemetry(self) -> dict[str, Any]:
        """Export metrics in OpenTelemetry-compatible format.

        Returns:
            Dict with metrics data suitable for OTLP export
        """
        result: dict[str, Any] = {
            "resource_metrics": [
                {
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"string_value": "smithers"}},
                        ]
                    },
                    "scope_metrics": [
                        {
                            "scope": {"name": "smithers.metrics"},
                            "metrics": [],
                        }
                    ],
                }
            ]
        }

        metrics_list = result["resource_metrics"][0]["scope_metrics"][0]["metrics"]

        # Export counters
        for metric in [
            self.workflow_runs_total,
            self.node_executions_total,
            self.llm_calls_total,
            self.tool_calls_total,
            self.cache_operations_total,
            self.llm_tokens_total,
        ]:
            if metric.values:
                metrics_list.append(self._counter_to_otlp(metric))

        # Export gauges
        for metric in [self.active_runs, self.pending_approvals]:
            if metric.values:
                metrics_list.append(self._gauge_to_otlp(metric))

        # Export histograms
        for metric in [
            self.workflow_duration_seconds,
            self.node_duration_seconds,
            self.llm_call_duration_seconds,
        ]:
            if metric.observations:
                metrics_list.append(self._histogram_to_otlp(metric))

        return result

    def _counter_to_otlp(self, metric: CounterMetric) -> dict[str, Any]:
        """Convert a counter to OTLP format."""
        data_points = []
        for labels, value in metric.values.items():
            point: dict[str, Any] = {
                "as_int": int(value),
                "attributes": [
                    {"key": k, "value": {"string_value": v}} for k, v in labels.labels.items()
                ],
            }
            data_points.append(point)

        return {
            "name": metric.name,
            "description": metric.help_text,
            "sum": {
                "data_points": data_points,
                "aggregation_temporality": 2,  # CUMULATIVE
                "is_monotonic": True,
            },
        }

    def _gauge_to_otlp(self, metric: GaugeMetric) -> dict[str, Any]:
        """Convert a gauge to OTLP format."""
        data_points = []
        for labels, value in metric.values.items():
            point: dict[str, Any] = {
                "as_double": value,
                "attributes": [
                    {"key": k, "value": {"string_value": v}} for k, v in labels.labels.items()
                ],
            }
            data_points.append(point)

        return {
            "name": metric.name,
            "description": metric.help_text,
            "gauge": {"data_points": data_points},
        }

    def _histogram_to_otlp(self, metric: HistogramMetric) -> dict[str, Any]:
        """Convert a histogram to OTLP format."""
        data_points = []
        for labels, values in metric.observations.items():
            bucket_counts = []
            for bucket_le in metric.buckets:
                bucket_counts.append(sum(1 for v in values if v <= bucket_le))
            bucket_counts.append(len(values))  # +Inf bucket

            point: dict[str, Any] = {
                "count": len(values),
                "sum": sum(values),
                "bucket_counts": bucket_counts,
                "explicit_bounds": metric.buckets,
                "attributes": [
                    {"key": k, "value": {"string_value": v}} for k, v in labels.labels.items()
                ],
            }
            data_points.append(point)

        return {
            "name": metric.name,
            "description": metric.help_text,
            "histogram": {
                "data_points": data_points,
                "aggregation_temporality": 2,  # CUMULATIVE
            },
        }

    # ==================== HTTP Server ====================

    def create_metrics_handler(self) -> type[BaseHTTPRequestHandler]:
        """Create an HTTP request handler for serving metrics."""
        collector = self

        class MetricsHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == "/metrics":
                    content = collector.export_prometheus()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content.encode("utf-8"))
                elif self.path == "/health":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"OK")
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                # Suppress default logging
                pass

        return MetricsHandler

    def start_server(
        self,
        host: str = "0.0.0.0",
        port: int = 9090,
        daemon: bool = True,
    ) -> HTTPServer:
        """Start an HTTP server for Prometheus scraping.

        Args:
            host: Host to bind to (default: "0.0.0.0")
            port: Port to listen on (default: 9090)
            daemon: Run as daemon thread (default: True)

        Returns:
            The HTTPServer instance
        """
        if self._server is not None:
            raise RuntimeError("Metrics server already running")

        handler_class = self.create_metrics_handler()
        self._server = HTTPServer((host, port), handler_class)
        self._server_thread = Thread(
            target=self._server.serve_forever,
            daemon=daemon,
        )
        self._server_thread.start()
        return self._server

    def stop_server(self) -> None:
        """Stop the HTTP server."""
        if self._server is not None:
            self._server.shutdown()
            self._server = None
        if self._server_thread is not None:
            self._server_thread.join(timeout=5.0)
            self._server_thread = None


# Global metrics collector instance
_global_collector: MetricsCollector | None = None


def get_metrics_collector() -> MetricsCollector:
    """Get the global metrics collector instance.

    Creates the instance on first call.
    """
    global _global_collector
    if _global_collector is None:
        _global_collector = MetricsCollector()
    return _global_collector


def set_metrics_collector(collector: MetricsCollector | None) -> MetricsCollector | None:
    """Set the global metrics collector instance.

    Useful for testing or customization. Pass None to reset.

    Returns:
        The previous collector instance
    """
    global _global_collector
    previous = _global_collector
    _global_collector = collector
    return previous


def reset_metrics_collector() -> None:
    """Reset the global metrics collector to a fresh instance.

    This clears all metrics and creates a new collector.
    """
    global _global_collector
    if _global_collector is not None:
        _global_collector.detach_from_event_bus()
        _global_collector.stop_server()
    _global_collector = MetricsCollector()


# Convenience functions for quick metric recording
def record_workflow_run(
    workflow_name: str,
    status: str,
    duration_seconds: float | None = None,
) -> None:
    """Record a workflow run completion."""
    collector = get_metrics_collector()
    collector.record_run_completed(workflow_name, status, duration_seconds)


def record_llm_call(
    model: str,
    duration_seconds: float | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
) -> None:
    """Record an LLM API call."""
    collector = get_metrics_collector()
    collector.record_llm_call(model, duration_seconds, input_tokens, output_tokens)


def record_tool_call(
    tool_name: str,
    status: str,
    duration_seconds: float | None = None,
) -> None:
    """Record a tool invocation."""
    collector = get_metrics_collector()
    collector.record_tool_call(tool_name, status, duration_seconds)
